//
// NOTE: This file is licensed under the GPLv3 license, see `IMAP-LICENSE`.
//
//       Source code was created with inspiration from WildDuck at <https://github.com/nodemailer/wildduck>.
//       WildDuck Mail Agent is licensed under the European Union Public License 1.2 or later.
//       <https://github.com/nodemailer/wildduck/blob/master/LICENSE>
//
//       Thank you to Andris Reinman, the author of WildDuck, Nodemailer, and many other OSS projects.
//       Please consider sponsoring their efforts as we do on GitHub at <https://github.com/andris9>.
//

const { Buffer } = require('node:buffer');
const { createHash } = require('node:crypto');

//
// NOTE: wait command not supported by `ioredis-mock`
// const Redis = require('ioredis-mock');
//
const Redis = require('@ladjs/redis');
const dayjs = require('dayjs-with-plugins');
const getPort = require('get-port');
const ip = require('ip');
const ms = require('ms');
const pWaitFor = require('p-wait-for');
const splitLines = require('split-lines');
const test = require('ava');
const { ImapFlow } = require('imapflow');
const { factory } = require('factory-girl');

const utils = require('../utils');
const IMAP = require('../../imap-server');

const Aliases = require('#models/aliases');
const Mailboxes = require('#models/mailboxes');
const Messages = require('#models/messages');
const config = require('#config');
const logger = require('#helpers/logger');

const IP_ADDRESS = ip.address();
const client = new Redis();
const subscriber = new Redis();
const tls = { rejectUnauthorized: false };

test.before(utils.setupMongoose);
test.before(utils.defineUserFactory);
test.before(utils.defineDomainFactory);
test.before(utils.definePaymentFactory);
test.before(utils.defineAliasFactory);
test.before(async () => {
  await client.flushall();
});
test.after.always(utils.teardownMongoose);
test.beforeEach(async (t) => {
  const secure = false;
  t.context.secure = secure;
  const imap = new IMAP({ client, subscriber }, secure);
  const port = await getPort();
  t.context.port = port;
  t.context.server = await imap.listen(port);
  t.context.imap = imap;

  const user = await factory.create('user', {
    plan: 'enhanced_protection',
    [config.userFields.planSetAt]: dayjs().startOf('day').toDate()
  });

  await factory.create('payment', {
    user: user._id,
    amount: 300,
    invoice_at: dayjs().startOf('day').toDate(),
    method: 'free_beta_program',
    duration: ms('30d'),
    plan: user.plan,
    kind: 'one-time'
  });

  t.context.user = await user.save();

  const domain = await factory.create('domain', {
    members: [{ user: user._id, group: 'admin' }],
    plan: user.plan,
    resolver: imap.resolver,
    has_smtp: true
  });

  t.context.domain = domain;

  const alias = await factory.create('alias', {
    user: user._id,
    domain: domain._id,
    recipients: [user.email]
  });

  const pass = await alias.createToken();
  t.context.pass = pass;
  t.context.alias = await alias.save();

  // spoof dns records
  const map = new Map();
  map.set(
    `txt:${domain.name}`,
    imap.resolver.spoofPacket(
      domain.name,
      'TXT',
      [`${config.paidPrefix}${domain.verification_record}`],
      true
    )
  );

  // store spoofed dns cache
  await imap.resolver.options.cache.mset(map);

  const imapFlow = new ImapFlow({
    host: IP_ADDRESS,
    port,
    secure,
    logger,
    tls,
    auth: {
      user: `${alias.name}@${domain.name}`,
      pass
    }
  });

  await imapFlow.connect();

  t.context.imapFlow = imapFlow;

  // create inbox
  await t.context.imapFlow.mailboxCreate('INBOX');
  const mailbox = await Mailboxes.findOne({
    alias: alias._id,
    path: 'INBOX'
  });
  t.is(mailbox.specialUse, '\\Inbox');
  t.is(mailbox.uidNext, 1);
});

test.afterEach(async (t) => {
  await t.context.imapFlow.logout();
  await t.context.imap.close();
});

test('onAppend', async (t) => {
  const { imapFlow, alias, domain } = t.context;

  //
  // `mailboxCreate(path)` whereas `path` is parsed by `normalizePath` function
  // <https://github.com/postalsys/imapflow/blob/d48d0d84e169d0c4315e32d1d565c08f382cace7/lib/tools.js#L36-L52>
  //
  await imapFlow.mailboxCreate('append');

  let mailbox = await Mailboxes.findOne({
    alias: alias._id,
    path: 'append'
  })
    .lean()
    .exec();

  const raw = `
Content-Type: multipart/mixed; boundary="------------cWFvDSey27tFG0hVYLqp9hs9"
MIME-Version: 1.0
To: ${alias.name}@${domain.name}
From: ${alias.name}@${domain.name}
Subject: test

This is a multi-part message in MIME format.
--------------cWFvDSey27tFG0hVYLqp9hs9
Content-Type: text/plain; charset=UTF-8; format=flowed
Content-Transfer-Encoding: 7bit

test

--------------cWFvDSey27tFG0hVYLqp9hs9
Content-Type: text/plain; charset=UTF-8; name="example.txt"
Content-Disposition: attachment; filename="example.txt"
Content-Transfer-Encoding: base64

ZXhhbXBsZQo=

--------------cWFvDSey27tFG0hVYLqp9hs9--`.trim();

  const append = await imapFlow.append(
    'append',
    Buffer.from(raw),
    ['\\Seen'],
    new Date()
  );

  // <https://github.com/postalsys/imapflow/issues/146#issuecomment-1747958257>
  t.is(append.destination, 'append');
  t.is(append.uid, 1);
  t.is(append.uidValidity, BigInt(mailbox.uidValidity));

  mailbox = await Mailboxes.findById(mailbox._id).lean().exec();

  t.is(mailbox.uidNext, 2);
});

test('onCreate', async (t) => {
  const mailbox = await t.context.imapFlow.mailboxCreate('beep');
  t.deepEqual(mailbox, {
    path: 'beep',
    created: true
  });
});

test('onFetch', async (t) => {
  const client = new ImapFlow({
    host: IP_ADDRESS,
    port: t.context.port,
    secure: t.context.secure,
    logger,
    tls,
    auth: {
      user: `${t.context.alias.name}@${t.context.domain.name}`,
      pass: t.context.pass
    }
  });
  await client.connect();

  // create mailbox folder
  const mbox = await client.mailboxCreate(['INBOX', 'fetch', 'child']);
  t.is(mbox.path, 'INBOX/fetch/child');
  const mailbox = await Mailboxes.findOne({
    alias: t.context.alias._id,
    path: 'INBOX/fetch/child'
  });
  t.true(typeof mailbox === 'object');
  t.is(mailbox.path, 'INBOX/fetch/child');

  //
  // write a bunch of messages to the mailbox (with and without attachments)
  //
  for (let i = 0; i < 100; i++) {
    const raw = `
Message-ID: <f869239d-3a31-4cb1-b30a-8a697252beb3@forwardemail.net>
Date: ${new Date().toISOString()}
MIME-Version: 1.0
Content-Language: en-US
To: ${t.context.alias.name}@${t.context.domain.name}
From: ${t.context.alias.name}@${t.context.domain.name}
Subject: test-${i}
Content-Type: text/plain; charset=UTF-8; format=flowed
Content-Transfer-Encoding: 7bit

test
`.trim();

    // eslint-disable-next-line no-await-in-loop
    await client.append('INBOX/fetch/child', Buffer.from(raw), [], new Date());
  }

  for (let i = 0; i < 100; i++) {
    const raw = `
Content-Type: multipart/mixed; boundary="------------cWFvDSey27tFG0hVYLqp9hs9"
MIME-Version: 1.0
To: ${t.context.alias.name}@${t.context.domain.name}
From: ${t.context.alias.name}@${t.context.domain.name}
Subject: test-${i}

This is a multi-part message in MIME format.
--------------cWFvDSey27tFG0hVYLqp9hs9
Content-Type: text/plain; charset=UTF-8; format=flowed
Content-Transfer-Encoding: 7bit

test-${i}

--------------cWFvDSey27tFG0hVYLqp9hs9
Content-Type: text/plain; charset=UTF-8; name="example.txt"
Content-Disposition: attachment; filename="example.txt"
Content-Transfer-Encoding: base64

ZXhhbXBsZQo=

--------------cWFvDSey27tFG0hVYLqp9hs9--`.trim();

    // eslint-disable-next-line no-await-in-loop
    await client.append('INBOX/fetch/child', Buffer.from(raw), [], new Date());
  }

  const lock = await client.getMailboxLock('INBOX/fetch/child');

  try {
    // fetchOne
    // `exists` is the largest seq number available in mailbox
    const message = await client.fetchOne(client.mailbox.exists, {
      source: true
    });

    const msg = await Messages.findOne({
      mailbox: mailbox._id,
      alias: t.context.alias._id,
      uid: message.uid
    })
      .lean()
      .exec();
    t.is(
      message.source.toString(),
      splitLines(msg.raw.toString()).join('\r\n')
    );

    // fetch
    // uid is always included, envelope strings are in unicode
    for await (const message of client.fetch('1:*', { envelope: true })) {
      // NOTE: since emailId not working (should be message.id from db)
      t.is(
        message.id,
        createHash('md5')
          .update(
            [
              mailbox.path,
              mailbox.uidValidity.toString(),
              message.uid.toString()
            ].join(':')
          )
          .digest('hex')
      );
    }

    // fetch (with search)
    for await (const message of client.fetch(
      {
        or: [{ to: `${t.context.alias.name}@${t.context.domain.name}` }]
      },
      { envelope: true, uid: true },
      { uid: true }
    )) {
      // NOTE: since emailId not working (should be message.id from db)
      t.is(
        message.id,
        createHash('md5')
          .update(
            [
              mailbox.path,
              mailbox.uidValidity.toString(),
              message.uid.toString()
            ].join(':')
          )
          .digest('hex')
      );
    }
  } finally {
    lock.release();
  }

  // cleanup
  await client.logout();
});

test('onSubscribe', async (t) => {
  await t.context.imapFlow.mailboxCreate('subscribe');
  const z = await t.context.imapFlow.mailboxSubscribe('subscribe');
  t.is(z, true);
  const f = await t.context.imapFlow.mailboxSubscribe('subscribeFail');
  t.is(f, false);
});

test('onUnsubscribe', async (t) => {
  await t.context.imapFlow.mailboxCreate('unsubscribe');
  t.is(await t.context.imapFlow.mailboxSubscribe('unsubscribe'), true);
  t.is(await t.context.imapFlow.mailboxUnsubscribe('unsubscribe'), true);
  t.is(await t.context.imapFlow.mailboxUnsubscribe('unsubscribe'), true);
});

test('onGetQuotaRoot', async (t) => {
  // creates unique user/domain/alias for quota
  // (otherwise would interfere with other tests)
  const user = await factory.create('user', {
    plan: 'enhanced_protection',
    [config.userFields.planSetAt]: dayjs().startOf('day').toDate()
  });

  await factory.create('payment', {
    user: user._id,
    amount: 300,
    invoice_at: dayjs().startOf('day').toDate(),
    method: 'free_beta_program',
    duration: ms('30d'),
    plan: user.plan,
    kind: 'one-time'
  });

  await user.save();

  const domain = await factory.create('domain', {
    members: [{ user: user._id, group: 'admin' }],
    plan: user.plan,
    resolver: t.context.imap.resolver,
    has_smtp: true
  });

  const alias = await factory.create('alias', {
    user: user._id,
    domain: domain._id,
    recipients: [user.email]
  });

  const pass = await alias.createToken();
  await alias.save();

  // spoof dns records
  const map = new Map();
  map.set(
    `txt:${domain.name}`,
    t.context.imap.resolver.spoofPacket(
      domain.name,
      'TXT',
      [`${config.paidPrefix}${domain.verification_record}`],
      true
    )
  );

  // store spoofed dns cache
  await t.context.imap.resolver.options.cache.mset(map);

  const imapFlow = new ImapFlow({
    host: IP_ADDRESS,
    port: t.context.port,
    secure: t.context.secure,
    logger,
    tls,
    auth: {
      user: `${alias.name}@${domain.name}`,
      pass
    }
  });

  await imapFlow.connect();

  await imapFlow.mailboxCreate('boopboop');

  {
    const quota = await imapFlow.getQuota('boopboop');
    t.deepEqual(quota, {
      path: 'boopboop',
      storage: {
        usage: 0,
        limit: config.maxQuotaPerAlias,
        status: '0%'
      }
    });
  }

  t.is(await imapFlow.getQuota('beepdoesnotexist'), false);

  // add a message to ensure quota used
  const raw = `
Content-Type: multipart/mixed; boundary="------------cWFvDSey27tFG0hVYLqp9hs9"
MIME-Version: 1.0
To: ${alias.name}@${domain.name}
From: ${alias.name}@${domain.name}
Subject: test

This is a multi-part message in MIME format.
--------------cWFvDSey27tFG0hVYLqp9hs9
Content-Type: text/plain; charset=UTF-8; format=flowed
Content-Transfer-Encoding: 7bit

test

--------------cWFvDSey27tFG0hVYLqp9hs9
Content-Type: text/plain; charset=UTF-8; name="example.txt"
Content-Disposition: attachment; filename="example.txt"
Content-Transfer-Encoding: base64

ZXhhbXBsZQo=

--------------cWFvDSey27tFG0hVYLqp9hs9--`.trim();

  const append = await imapFlow.append(
    'boopboop',
    Buffer.from(raw),
    ['\\Seen'],
    new Date()
  );

  const mailbox = await Mailboxes.findOne({
    alias: alias._id,
    path: append.destination
  });

  t.is(mailbox.path, append.destination);

  {
    const message = await Messages.findOne({
      alias: alias._id,
      mailbox: mailbox._id,
      uid: append.uid
    })
      .lean()
      .exec();
    const storageUsed = await Aliases.getStorageUsed(alias);
    t.is(storageUsed, 604);
    const quota = await imapFlow.getQuota('boopboop');
    t.deepEqual(quota, {
      path: 'boopboop',
      storage: {
        // message size is rounded to nearest 1024 bytes
        usage: Math.ceil(message.size / 1024) * 1024,
        limit: config.maxQuotaPerAlias,
        status: '0%'
      }
    });
  }
});

test('onGetQuota', async (t) => {
  const quota = await t.context.imapFlow.getQuota();
  t.deepEqual(quota, {
    path: 'INBOX',
    storage: {
      usage: 0,
      limit: config.maxQuotaPerAlias,
      status: '0%'
    }
  });
});

test('onCopy', async (t) => {
  // create a bunch of messages in copy folder
  await t.context.imapFlow.mailboxCreate('copy');
  for (let i = 0; i < 10; i++) {
    const raw = `
Date: ${new Date().toISOString()}
MIME-Version: 1.0
Content-Language: en-US
To: ${t.context.alias.name}@${t.context.domain.name}
From: ${t.context.alias.name}@${t.context.domain.name}
Subject: test-${i}
Content-Type: text/plain; charset=UTF-8; format=flowed
Content-Transfer-Encoding: 7bit

test
`.trim();

    // eslint-disable-next-line no-await-in-loop
    await t.context.imapFlow.append('copy', Buffer.from(raw), [], new Date());
  }

  // connect to mailbox
  await t.context.imapFlow.mailboxOpen('copy');

  // attempt to copy messages to "backup" folder
  // when it doesn't yet exist results in a fail (false)
  t.is(await t.context.imapFlow.messageCopy('1:*', 'backup'), false);

  // copy all messages to a mailbox called "Backup" (must exist)
  await t.context.imapFlow.mailboxCreate('backup');
  const result = await t.context.imapFlow.messageCopy('1:*', 'backup');
  t.is(result.path, 'copy');
  t.is(result.destination, 'backup');
  t.is(result.uidMap.size, 10);
});

// delete removes an entire mailbox
test('onDelete', async (t) => {
  const err = await t.throwsAsync(t.context.imapFlow.mailboxDelete('BOOPBAZ'));
  t.is(err.message, 'Command failed');
  t.regex(err.response, /NO \[NONEXISTENT] DELETE completed/);
  t.is(err.responseStatus, 'NO');
  t.is(err.responseText, 'DELETE completed');
  t.is(err.serverResponseCode, 'NONEXISTENT');
  await t.context.imapFlow.mailboxCreate('WUHWOH');
  const info = await t.context.imapFlow.mailboxDelete('WUHWOH');
  t.is(info.path, 'WUHWOH');
});

// expunge deletes messages
test('onExpunge', async (t) => {
  await t.context.imapFlow.mailboxCreate('expunge');

  const raw = `
Content-Type: multipart/mixed; boundary="------------cWFvDSey27tFG0hVYLqp9hs9"
MIME-Version: 1.0
To: ${t.context.alias.name}@${t.context.domain.name}
From: ${t.context.alias.name}@${t.context.domain.name}
Subject: test

This is a multi-part message in MIME format.
--------------cWFvDSey27tFG0hVYLqp9hs9
Content-Type: text/plain; charset=UTF-8; format=flowed
Content-Transfer-Encoding: 7bit

test

--------------cWFvDSey27tFG0hVYLqp9hs9
Content-Type: text/plain; charset=UTF-8; name="example.txt"
Content-Disposition: attachment; filename="example.txt"
Content-Transfer-Encoding: base64

ZXhhbXBsZQo=

--------------cWFvDSey27tFG0hVYLqp9hs9--`.trim();

  await t.context.imapFlow.append(
    'expunge',
    Buffer.from(raw),
    ['\\Seen'],
    new Date()
  );

  const mailbox = await Mailboxes.findOne({
    alias: t.context.alias._id,
    path: 'expunge'
  });

  t.is(mailbox.path, 'expunge');

  // note that a message won't get marked as deleted
  // since it has to have a Deleted flag at first
  const uids = await Messages.distinct('uid', {
    mailbox: mailbox._id,
    alias: t.context.alias._id,
    undeleted: true
  });

  t.is(uids.length, 1);

  await t.context.imapFlow.mailboxOpen('expunge');

  t.true(
    await t.context.imapFlow.messageFlagsAdd(
      uids,
      ['\\Deleted'],
      // <https://github.com/postalsys/imapflow/issues/21#issuecomment-658773009>
      { uid: true }
    )
  );

  let data;
  t.context.imapFlow.on('expunge', (_data) => {
    data = _data;
  });

  t.true(await t.context.imapFlow.messageDelete({ all: true }));

  if (!data) await pWaitFor(() => Boolean(data), { timeout: ms('5s') });

  t.is(data.path, 'expunge');
  t.is(data.vanished, false);
  t.is(data.seq, 1);
});

// NOTE: onLsub is taken care of by onSubscribe and unSubscribe
// test('onLsub', async (t) => {});

test('onMove', async (t) => {
  // create a bunch of messages in move folder
  await t.context.imapFlow.mailboxCreate('move');
  for (let i = 0; i < 10; i++) {
    const raw = `
Date: ${new Date().toISOString()}
MIME-Version: 1.0
Content-Language: en-US
To: ${t.context.alias.name}@${t.context.domain.name}
From: ${t.context.alias.name}@${t.context.domain.name}
Subject: test-${i}
Content-Type: text/plain; charset=UTF-8; format=flowed
Content-Transfer-Encoding: 7bit

test
`.trim();

    // eslint-disable-next-line no-await-in-loop
    await t.context.imapFlow.append('move', Buffer.from(raw), [], new Date());
  }

  // connect to mailbox
  await t.context.imapFlow.mailboxOpen('move');

  // attempt to move messages to "was-moved" folder
  // when it doesn't yet exist results in a fail (false)
  t.is(await t.context.imapFlow.messageMove('1:*', 'was-moved'), false);

  // move all messages to a mailbox called "was-moved" (ust exist)
  await t.context.imapFlow.mailboxCreate('was-moved');
  const result = await t.context.imapFlow.messageMove('1:*', 'was-moved');
  t.is(result.path, 'move');
  t.is(result.destination, 'was-moved');
  t.is(result.uidMap.size, 10);
});

test('onOpen', async (t) => {
  await t.context.imapFlow.mailboxCreate('opened');
  const result = await t.context.imapFlow.mailboxOpen('opened');
  t.is(result.path, 'opened');
});

test('onRename', async (t) => {
  await t.context.imapFlow.mailboxCreate(['parent', 'child']);
  const info = await t.context.imapFlow.mailboxRename(
    'parent/child',
    'important'
  );
  t.is(info.path, 'parent/child');
  t.is(info.newPath, 'important');
});

test('onSearch', async (t) => {
  await t.context.imapFlow.mailboxCreate('searchwoowoo');

  // create a bunch of seen and unseen messages
  for (let i = 0; i < 10; i++) {
    const raw = `
Date: ${new Date().toISOString()}
MIME-Version: 1.0
Content-Language: en-US
To: ${t.context.alias.name}@${t.context.domain.name}
From: Linus <${t.context.alias.name}@${t.context.domain.name}>
Subject: Beep Baz Boop unseen-test-${i}
Content-Type: text/plain; charset=UTF-8; format=flowed
Content-Transfer-Encoding: 7bit

test Snap Ya Ya Ya
`.trim();

    // eslint-disable-next-line no-await-in-loop
    await t.context.imapFlow.append(
      'searchwoowoo',
      Buffer.from(raw),
      [],
      new Date()
    );
  }

  for (let i = 0; i < 10; i++) {
    const raw = `
Date: ${new Date().toISOString()}
MIME-Version: 1.0
Content-Language: en-US
To: ${t.context.alias.name}@${t.context.domain.name}
From: ${t.context.alias.name}@${t.context.domain.name}
Subject: seen-test-${i}
Content-Type: text/plain; charset=UTF-8; format=flowed
Content-Transfer-Encoding: 7bit

test
`.trim();

    // eslint-disable-next-line no-await-in-loop
    await t.context.imapFlow.append(
      'searchwoowoo',
      Buffer.from(raw),
      ['\\Seen'],
      new Date()
    );
  }

  await t.context.imapFlow.mailboxOpen('searchwoowoo');

  // find all unseen messages
  const list1 = await t.context.imapFlow.search({ seen: true });
  // use OR modifier (array of 2 or more search queries)
  const list2 = await t.context.imapFlow.search({
    seen: false,
    or: [{ flagged: true }, { from: 'linus' }]
  });
  t.is(list1.length, 10);
  t.is(list2.length, 10);
  t.notDeepEqual(list1, list2);

  //
  // iterate over all possible search params for maximum coverage
  // (we can further refine this in the future)
  //

  // booleans
  for (const key of [
    'answered',
    'deleted',
    'draft',
    'flagged',
    'seen',
    'all',
    'new',
    'old',
    'recent'
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.context.imapFlow.search({ [key]: false });
    // eslint-disable-next-line no-await-in-loop
    await t.context.imapFlow.search({ [key]: true });
  }

  // strings (e.g. $text search)
  for (const key of [
    'to',
    'from',
    'cc',
    'bcc',
    'body',
    'subject',
    'keyword',
    'unKeyword'
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.context.imapFlow.search({ [key]: 'test' });
  }

  // size
  for (const key of ['larger', 'smaller']) {
    // eslint-disable-next-line no-await-in-loop
    await t.context.imapFlow.search({ [key]: 100 });
  }

  // dates
  for (const key of [
    'before',
    'on',
    'since',
    'sentBefore',
    'sentOn',
    'sentSince'
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.context.imapFlow.search({ [key]: new Date(Date.now() + 10000) });
  }
});

test('onStatus', async (t) => {
  await t.context.imapFlow.mailboxCreate('yoyo');

  // create a bunch of seen and unseen messages
  for (let i = 0; i < 10; i++) {
    const raw = `
Date: ${new Date().toISOString()}
MIME-Version: 1.0
Content-Language: en-US
To: ${t.context.alias.name}@${t.context.domain.name}
From: ${t.context.alias.name}@${t.context.domain.name}
Subject: unseen-test-${i}
Content-Type: text/plain; charset=UTF-8; format=flowed
Content-Transfer-Encoding: 7bit

test
`.trim();

    // eslint-disable-next-line no-await-in-loop
    await t.context.imapFlow.append('yoyo', Buffer.from(raw), [], new Date());
  }

  for (let i = 0; i < 10; i++) {
    const raw = `
Date: ${new Date().toISOString()}
MIME-Version: 1.0
Content-Language: en-US
To: ${t.context.alias.name}@${t.context.domain.name}
From: ${t.context.alias.name}@${t.context.domain.name}
Subject: seen-test-${i}
Content-Type: text/plain; charset=UTF-8; format=flowed
Content-Transfer-Encoding: 7bit

test
`.trim();

    // eslint-disable-next-line no-await-in-loop
    await t.context.imapFlow.append(
      'yoyo',
      Buffer.from(raw),
      ['\\Seen'],
      new Date()
    );
  }

  await t.context.imapFlow.mailboxOpen('yoyo');
  const status = await t.context.imapFlow.status('yoyo', {
    messages: true,
    unseen: true
  });
  t.is(status.path, 'yoyo');
  t.is(status.messages, 20);
  t.is(status.unseen, 10);
});

test('message flags set', async (t) => {
  await t.context.imapFlow.mailboxCreate('flag-set');

  const raw = `
Content-Type: multipart/mixed; boundary="------------cWFvDSey27tFG0hVYLqp9hs9"
MIME-Version: 1.0
To: ${t.context.alias.name}@${t.context.domain.name}
From: ${t.context.alias.name}@${t.context.domain.name}
Subject: test

This is a multi-part message in MIME format.
--------------cWFvDSey27tFG0hVYLqp9hs9
Content-Type: text/plain; charset=UTF-8; format=flowed
Content-Transfer-Encoding: 7bit

test

--------------cWFvDSey27tFG0hVYLqp9hs9
Content-Type: text/plain; charset=UTF-8; name="example.txt"
Content-Disposition: attachment; filename="example.txt"
Content-Transfer-Encoding: base64

ZXhhbXBsZQo=

--------------cWFvDSey27tFG0hVYLqp9hs9--`.trim();

  await t.context.imapFlow.append(
    'flag-set',
    Buffer.from(raw),
    ['\\Seen', '\\Flagged', '\\Draft'],
    new Date()
  );

  await t.context.imapFlow.mailboxOpen('flag-set');

  t.true(
    await t.context.imapFlow.messageFlagsSet({ all: true }, ['\\Deleted'])
  );

  const mailbox = await Mailboxes.findOne({
    path: 'flag-set',
    alias: t.context.alias._id
  });

  t.is(mailbox.path, 'flag-set');

  const message = await Messages.findOne({
    mailbox: mailbox._id,
    alias: t.context.alias._id
  });

  t.deepEqual(message.flags, ['\\Deleted']);
});

test('message flags remove', async (t) => {
  await t.context.imapFlow.mailboxCreate('flag-remove');

  const raw = `
Content-Type: multipart/mixed; boundary="------------cWFvDSey27tFG0hVYLqp9hs9"
MIME-Version: 1.0
To: ${t.context.alias.name}@${t.context.domain.name}
From: ${t.context.alias.name}@${t.context.domain.name}
Subject: test

This is a multi-part message in MIME format.
--------------cWFvDSey27tFG0hVYLqp9hs9
Content-Type: text/plain; charset=UTF-8; format=flowed
Content-Transfer-Encoding: 7bit

test

--------------cWFvDSey27tFG0hVYLqp9hs9
Content-Type: text/plain; charset=UTF-8; name="example.txt"
Content-Disposition: attachment; filename="example.txt"
Content-Transfer-Encoding: base64

ZXhhbXBsZQo=

--------------cWFvDSey27tFG0hVYLqp9hs9--`.trim();

  await t.context.imapFlow.append(
    'flag-remove',
    Buffer.from(raw),
    ['\\Seen', '\\Flagged', '\\Draft'],
    new Date()
  );

  await t.context.imapFlow.mailboxOpen('flag-remove');

  t.true(
    await t.context.imapFlow.messageFlagsRemove({ all: true }, ['\\Flagged'])
  );

  const mailbox = await Mailboxes.findOne({
    path: 'flag-remove',
    alias: t.context.alias._id
  });

  t.is(mailbox.path, 'flag-remove');

  const message = await Messages.findOne({
    mailbox: mailbox._id,
    alias: t.context.alias._id
  });

  t.deepEqual(message.flags, ['\\Seen', '\\Draft']);
});