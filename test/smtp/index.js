const util = require('util');
const { Writable } = require('node:stream');

// TODO: message body starts with "\" does not hash verify

const Client = require('nodemailer/lib/smtp-connection');
const Redis = require('ioredis-mock');
const dayjs = require('dayjs-with-plugins');
const getPort = require('get-port');
const ip = require('ip');
const ms = require('ms');
const mxConnect = require('mx-connect');
const nodemailer = require('nodemailer');
const pify = require('pify');
const test = require('ava');
const { SMTPServer } = require('smtp-server');
const { factory } = require('factory-girl');

const utils = require('../utils');
const SMTP = require('../../smtp-server');

const config = require('#config');
const env = require('#config/env');
const logger = require('#helpers/logger');
const processEmail = require('#helpers/process-email');
const { Emails } = require('#models');

const asyncMxConnect = pify(mxConnect);
const IP_ADDRESS = ip.address();
const client = new Redis();
const tls = { rejectUnauthorized: false };

test.before(utils.setupMongoose);
test.before(utils.defineUserFactory);
test.before(utils.defineDomainFactory);
test.before(utils.definePaymentFactory);
test.before(utils.defineAliasFactory);
test.after.always(utils.teardownMongoose);
test.beforeEach(utils.setupSMTPServer);

test('starttls required for non-secure auth', async (t) => {
  const secure = false;
  const smtp = new SMTP({ client: t.context.client }, secure);
  const { resolver } = smtp;
  const port = await getPort();
  await smtp.listen(port);

  const mx = await asyncMxConnect({
    target: IP_ADDRESS,
    port: smtp.server.address().port,
    dnsOptions: {
      // <https://github.com/zone-eu/mx-connect/pull/4>
      resolve: util.callbackify(resolver.resolve.bind(resolver))
    }
  });

  const transporter = nodemailer.createTransport({
    logger,
    debug: true,
    host: mx.host,
    port: mx.port,
    connection: mx.socket,
    ignoreTLS: true, // <--- this causes the test to error (which is what we want)
    // set `secure` to `true` for port 465 otherwise `false` for port 587, 2587, 25, and 2525
    secure,
    tls: {
      rejectUnauthorized: false
    },
    auth: {
      user: 'test@test.com',
      pass: 'test'
    }
  });

  const err = await t.throwsAsync(
    transporter.sendMail({
      envelope: {
        from: 'test@test.com',
        to: 'test@test.com'
      },
      raw: `
To: test@test.com
From: test@test.com
Subject: test
Content-Type: text/plain; charset=us-ascii
Content-Transfer-Encoding: 7bit

Test`.trim()
    })
  );

  t.is(err.responseCode, 538);
  t.is(err.response, '538 Error: Must issue a STARTTLS command first');
});

test('starttls disabled for secure auth', async (t) => {
  const secure = true;
  const smtp = new SMTP({ client: t.context.client }, secure);
  const port = await getPort();
  await smtp.listen(port);

  {
    const transporter = nodemailer.createTransport({
      logger,
      debug: true,
      host: IP_ADDRESS,
      port,
      ignoreTLS: true,
      // set `secure` to `true` for port 465 otherwise `false` for port 587, 2587, 25, and 2525
      secure,
      tls: {
        rejectUnauthorized: false
      },
      auth: {
        user: 'test@test.com',
        pass: 'test'
      }
    });

    const err = await t.throwsAsync(
      transporter.sendMail({
        envelope: {
          from: 'test@test.com',
          to: 'test@test.com'
        },
        raw: `
To: test@test.com
From: test@test.com
Subject: test
Content-Type: text/plain; charset=us-ascii
Content-Transfer-Encoding: 7bit

Test`.trim()
      })
    );

    t.is(err.responseCode, 535);
    t.is(err.response, '535 Invalid username or password');
  }

  {
    const transporter = nodemailer.createTransport({
      logger,
      debug: true,
      host: IP_ADDRESS,
      port,
      requireTLS: true,
      secure,
      tls: {
        rejectUnauthorized: false
      },
      auth: {
        user: 'test@test.com',
        pass: 'test'
      }
    });

    const err = await t.throwsAsync(
      transporter.sendMail({
        envelope: {
          from: 'test@test.com',
          to: 'test@test.com'
        },
        raw: `
To: test@test.com
From: test@test.com
Subject: test
Content-Type: text/plain; charset=us-ascii
Content-Transfer-Encoding: 7bit

Test`.trim()
      })
    );

    t.is(err.responseCode, 535);
    t.is(err.response, '535 Invalid username or password');
  }
});

test('smtp outbound auth', async (t) => {
  const smtp = new SMTP({ client: t.context.client }, false);
  const { resolver } = smtp;
  const port = await getPort();
  await smtp.listen(port);

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
    resolver,
    has_smtp: true
  });

  const alias = await factory.create('alias', {
    user: user._id,
    domain: domain._id,
    recipients: [user.email]
  });

  const pass = await alias.createToken();
  t.true(typeof pass === 'string' && pass.length === 24);
  await alias.save();

  const combos = [
    { user: 'a', pass: 'a' },
    { user: `beep@${domain.name}`, pass },
    { user: `${alias.name}@${domain.name.replace('.com', '')}`, pass },
    { user: alias.name, pass }
  ];

  // invalid combos
  for (const combo of combos) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      const connection = new Client({ port, tls });
      connection.connect(() => {
        connection.login(combo, (err) => {
          t.is(err.responseCode, 535);
          t.is(err.response, '535 Invalid username or password');
          connection.close();
        });
      });
      connection.once('end', () => resolve());
    });
  }

  // spoof dns records
  const map = new Map();
  map.set(
    `txt:${domain.name}`,
    resolver.spoofPacket(
      domain.name,
      'TXT',
      [`${config.paidPrefix}${domain.verification_record}`],
      true
    )
  );

  // store spoofed dns cache
  await resolver.options.cache.mset(map);

  // success
  await new Promise((resolve) => {
    const connection = new Client({ port, tls });
    connection.connect(() => {
      connection.login(
        { user: `${alias.name}@${domain.name}`, pass },
        (err) => {
          t.is(err, null);
          connection.close();
        }
      );
    });
    connection.once('end', () => resolve());
  });
});

test('smtp outbound queue', async (t) => {
  const smtp = new SMTP({ client: t.context.client }, false);
  const { resolver } = smtp;
  const port = await getPort();
  await smtp.listen(port);

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
    resolver,
    has_smtp: true
  });

  const alias = await factory.create('alias', {
    user: user._id,
    domain: domain._id,
    recipients: [user.email]
  });

  const pass = await alias.createToken();
  await alias.save();

  {
    // spoof dns records
    const map = new Map();

    map.set(
      `txt:${domain.name}`,
      resolver.spoofPacket(
        domain.name,
        'TXT',
        [`${config.paidPrefix}${domain.verification_record}`],
        true
      )
    );

    // dkim
    map.set(
      `txt:${domain.dkim_key_selector}._domainkey.${domain.name}`,
      resolver.spoofPacket(
        `${domain.dkim_key_selector}._domainkey.${domain.name}`,
        'TXT',
        [`v=DKIM1; k=rsa; p=${domain.dkim_public_key.toString('base64')};`],
        true
      )
    );

    // spf
    map.set(
      `txt:${env.WEB_HOST}`,
      resolver.spoofPacket(
        `${env.WEB_HOST}`,
        'TXT',
        [`v=spf1 ip4:${IP_ADDRESS} -all`],
        true
      )
    );

    // cname
    map.set(
      `cname:${domain.return_path}.${domain.name}`,
      resolver.spoofPacket(
        `${domain.return_path}.${domain.name}`,
        'CNAME',
        [env.WEB_HOST],
        true
      )
    );

    // cname -> txt
    map.set(
      `txt:${domain.return_path}.${domain.name}`,
      resolver.spoofPacket(
        `${domain.return_path}.${domain.name}`,
        'TXT',
        [`v=spf1 ip4:${IP_ADDRESS} -all`],
        true
      )
    );

    // dmarc
    map.set(
      `txt:_dmarc.${domain.name}`,
      resolver.spoofPacket(
        `_dmarc.${domain.name}`,
        'TXT',
        [
          // TODO: consume dmarc reports and parse dmarc-$domain
          `v=DMARC1; p=reject; pct=100; rua=mailto:dmarc-${domain.id}@forwardemail.net;`
        ],
        true
      )
    );

    // store spoofed dns cache
    await resolver.options.cache.mset(map);
  }

  const mx = await asyncMxConnect({
    target: IP_ADDRESS,
    port: smtp.server.address().port,
    dnsOptions: {
      // <https://github.com/zone-eu/mx-connect/pull/4>
      resolve: util.callbackify(resolver.resolve.bind(resolver))
    }
  });

  const transporter = nodemailer.createTransport({
    logger,
    debug: true,
    host: mx.host,
    port: mx.port,
    connection: mx.socket,
    // ignoreTLS: true,
    // set `secure` to `true` for port 465 otherwise `false` for port 587, 2587, 25, and 2525
    secure: false,
    tls: {
      rejectUnauthorized: false
    },
    auth: {
      user: `${alias.name}@${domain.name}`,
      pass
    }
  });

  const info = await transporter.sendMail({
    envelope: {
      from: `${alias.name}@${domain.name}`,
      to: [
        'test@foo.com',
        'beep@boop.com',
        'foo@bar.com',
        'a@xyz.com',
        'b@xyz.com'
      ]
    },
    raw: `
Sender: baz@beep.com
Cc: beep@boop.com,beep@boop.com
Bcc: foo@bar.com,a@xyz.com,b@xyz.com
Reply-To: boop@beep.com
Message-Id: beep-boop
To: test@foo.com
From: Test <${alias.name}@${domain.name}>
Subject: testing this
Content-Type: text/plain; charset=us-ascii
Content-Transfer-Encoding: 7bit

Test`.trim()
  });

  // info.accepted
  // info.rejected
  // info.rejectedErrors
  t.deepEqual(
    info.accepted.sort(),
    [
      'test@foo.com',
      'beep@boop.com',
      'foo@bar.com',
      'a@xyz.com',
      'b@xyz.com'
    ].sort()
  );

  let email = await Emails.findOne();
  t.true(typeof email === 'object');
  // TODO: validate by message-id too to ensure it's the right email
  delete email.message; // suppress buffer output from console log
  t.is(email.status, 'queued');

  // validate envelope
  t.is(email.envelope.from, `${alias.name}@${domain.name}`);
  t.deepEqual(
    email.envelope.to.sort(),
    [
      'test@foo.com',
      'beep@boop.com',
      'foo@bar.com',
      'a@xyz.com',
      'b@xyz.com'
    ].sort()
  );

  // validate message-id
  t.is(email.messageId, '<beep-boop>');

  //
  // spoof envelope RCPT TO mx records
  //
  // - test@foo.com
  // - beep@boop.com
  // - foo@bar.com
  // - a@xyz.com <-- accepted
  // - b@xyz.com <-- rejected
  //
  {
    const map = new Map();
    for (const to of email.envelope.to) {
      const [, domain] = to.split('@');
      map.set(
        `mx:${domain}`,
        resolver.spoofPacket(
          domain,
          'MX',
          [{ exchange: IP_ADDRESS, priority: 0 }],
          true
        )
      );
    }

    await resolver.options.cache.mset(map);
  }

  // spin up a test smtp server that simply responds with OK
  const testPort = await getPort();
  let attempted = false;
  const server = new SMTPServer({
    disabledCommands: ['AUTH'],
    onRcptTo(address, session, fn) {
      if (!attempted && address?.address === email.envelope.to.slice(-1)[0]) {
        attempted = true;
        const err = new Error('Rejected!');
        // NOTE: smtp-server will close connection early if it's 421
        err.responseCode = 450;
        err.response = '450 Rejected!';
        return fn(err);
      }

      fn();
    },
    onConnect(session, fn) {
      fn();
    },
    onData(stream, session, fn) {
      const chunks = [];
      const writer = new Writable({
        write(chunk, encoding, fn) {
          chunks.push(chunk);
          fn();
        }
      });
      stream.pipe(writer);
      stream.on('end', () => {
        // const buffer = Buffer.concat(chunks);
        // t.log(buffer.toString());
        fn();
      });
    },
    logInfo: true,
    logger,
    secure: false
  });

  // start test smtp server
  await pify(server.listen.bind(server))(testPort);

  //
  // process the email
  //
  await processEmail({
    email,
    port: testPort,
    resolver,
    client
  });

  //
  // ensure email delivered except 1 address which will be retried next send
  //
  email = await Emails.findById(email._id);
  delete email.message; // suppress buffer output from console log
  t.is(email.status, 'deferred');
  t.deepEqual(email.accepted.sort(), email.envelope.to.slice(0, -1).sort());
  t.true(email.rejectedErrors.length === 1);
  t.is(email.rejectedErrors[0].code, 'EENVELOPE');
  t.is(email.rejectedErrors[0].response, '450 Rejected!');
  t.is(email.rejectedErrors[0].responseCode, 450);
  t.is(email.rejectedErrors[0].command, 'RCPT TO');
  t.is(email.rejectedErrors[0].recipient, email.envelope.to.slice(-1)[0]);

  // process the email again and let the deferred go through this time
  email = await Emails.findById(email._id);
  t.is(email.status, 'deferred');
  email.status = 'queued';
  await Emails.findByIdAndUpdate(email._id, {
    $set: { status: 'queued' },
    $unset: { locked_at: 1, locked_by: 1 }
  });
  email = await Emails.findById(email._id);
  t.is(email.status, 'queued');
  t.is(email.locked_at, undefined);
  t.is(email.locked_by, undefined);

  await processEmail({
    email,
    port: testPort,
    resolver,
    client
  });

  // ensure sent
  email = await Emails.findById(email._id);
  delete email.message; // suppress buffer output from console log
  t.is(email.status, 'sent');
  t.deepEqual(email.accepted.sort(), email.envelope.to.sort());
  t.deepEqual(email.rejectedErrors, []);
});

test('smtp rate limiting', async (t) => {
  const smtp = new SMTP({ client: t.context.client }, false);
  const { resolver } = smtp;
  const port = await getPort();
  await smtp.listen(port);

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
    resolver,
    has_smtp: true
  });

  const alias = await factory.create('alias', {
    user: user._id,
    domain: domain._id,
    recipients: [user.email]
  });

  const pass = await alias.createToken();
  await alias.save();

  {
    // spoof dns records
    const map = new Map();

    // custom expiry since this test takes longer
    const expires = dayjs().add(1, 'day').toDate();

    map.set(
      `txt:${domain.name}`,
      resolver.spoofPacket(
        domain.name,
        'TXT',
        [`${config.paidPrefix}${domain.verification_record}`],
        true,
        expires
      )
    );

    // dkim
    map.set(
      `txt:${domain.dkim_key_selector}._domainkey.${domain.name}`,
      resolver.spoofPacket(
        `${domain.dkim_key_selector}._domainkey.${domain.name}`,
        'TXT',
        [`v=DKIM1; k=rsa; p=${domain.dkim_public_key.toString('base64')};`],
        true,
        expires
      )
    );

    // spf
    map.set(
      `txt:${env.WEB_HOST}`,
      resolver.spoofPacket(
        `${env.WEB_HOST}`,
        'TXT',
        [`v=spf1 ip4:${IP_ADDRESS} -all`],
        true,
        expires
      )
    );

    // cname
    map.set(
      `cname:${domain.return_path}.${domain.name}`,
      resolver.spoofPacket(
        `${domain.return_path}.${domain.name}`,
        'CNAME',
        [env.WEB_HOST],
        true,
        expires
      )
    );

    // cname -> txt
    map.set(
      `txt:${domain.return_path}.${domain.name}`,
      resolver.spoofPacket(
        `${domain.return_path}.${domain.name}`,
        'TXT',
        [`v=spf1 ip4:${IP_ADDRESS} -all`],
        true,
        expires
      )
    );

    // dmarc
    map.set(
      `txt:_dmarc.${domain.name}`,
      resolver.spoofPacket(
        `_dmarc.${domain.name}`,
        'TXT',
        [
          // TODO: consume dmarc reports and parse dmarc-$domain
          `v=DMARC1; p=reject; pct=100; rua=mailto:dmarc-${domain.id}@forwardemail.net;`
        ],
        true,
        expires
      )
    );

    // store spoofed dns cache
    await resolver.options.cache.mset(map);
  }

  // from n to limit, it should not error
  for (let i = 1; i <= config.smtpLimitMessages + 10; i++) {
    // eslint-disable-next-line no-await-in-loop
    const mx = await asyncMxConnect({
      target: IP_ADDRESS,
      port: smtp.server.address().port,
      dnsOptions: {
        // <https://github.com/zone-eu/mx-connect/pull/4>
        resolve: util.callbackify(resolver.resolve.bind(resolver))
      }
    });

    const transporter = nodemailer.createTransport({
      logger,
      debug: true,
      host: mx.host,
      port: mx.port,
      connection: mx.socket,
      // ignoreTLS: true,
      // set `secure` to `true` for port 465 otherwise `false` for port 587, 2587, 25, and 2525
      secure: false,
      tls: {
        rejectUnauthorized: false
      },
      auth: {
        user: `${alias.name}@${domain.name}`,
        pass
      }
    });

    if (i > config.smtpLimitMessages) {
      // eslint-disable-next-line no-await-in-loop
      const err = await t.throwsAsync(
        transporter.sendMail({
          envelope: {
            from: `${alias.name}@${domain.name}`,
            to: ['test@foo.com']
          },
          raw: `
To: test@foo.com
From: Test <${alias.name}@${domain.name}>
Subject: testing this
Content-Type: text/plain; charset=us-ascii
Content-Transfer-Encoding: 7bit

Test`.trim()
        })
      );

      t.is(err.responseCode, 550);
      t.is(err.response, '550 Rate limit exceeded');
    } else {
      // eslint-disable-next-line no-await-in-loop
      const info = await transporter.sendMail({
        envelope: {
          from: `${alias.name}@${domain.name}`,
          to: ['test@foo.com']
        },
        raw: `
To: test@foo.com
From: Test <${alias.name}@${domain.name}>
Subject: testing this
Content-Type: text/plain; charset=us-ascii
Content-Transfer-Encoding: 7bit

Test`.trim()
      });

      t.deepEqual(info.accepted, ['test@foo.com']);
    }
  }
});