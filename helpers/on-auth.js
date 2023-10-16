/**
 * Copyright (c) Forward Email LLC
 * SPDX-License-Identifier: BUSL-1.1
 */

const punycode = require('node:punycode');

const isSANB = require('is-string-and-not-blank');
const { IMAPServer } = require('wildduck/imap-core');
const { isEmail } = require('validator');

const SMTPError = require('./smtp-error');
const ServerShutdownError = require('./server-shutdown-error');
const SocketError = require('./socket-error');
const logger = require('./logger');
const parseRootDomain = require('./parse-root-domain');
const refineAndLogError = require('./refine-and-log-error');
const validateAlias = require('./validate-alias');
const validateDomain = require('./validate-domain');

const Aliases = require('#models/aliases');
const Domains = require('#models/domains');
const Mailboxes = require('#models/mailboxes');
const config = require('#config');
const env = require('#config/env');

const REQUIRED_PATHS = [
  'INBOX',
  'Drafts',
  'Sent Mail',
  //
  // NOTE: we could use "All Mail" to match existing standards (e.g. instead of "Archive")
  // <https://github.com/mozilla/releases-comm-central/blob/34d8c5cba2df3154e1c38b376e8c10ca24e4f939/mailnews/imap/src/nsImapMailFolder.cpp#L1171-L1173>
  //
  // 'All Mail' but we would need to use labels
  //
  'Archive',
  'Spam',
  'Trash'
];

// eslint-disable-next-line complexity
async function onAuth(auth, session, fn) {
  logger.debug('AUTH', { auth, session });

  // TODO: credit system + domain billing rules (assigned billing manager -> person who gets credits deducted)
  // TODO: salt/hash/deprecate legacy API token + remove from API docs page
  // TODO: replace usage of config.recordPrefix with config.paidPrefix and config.freePrefix

  //
  // TODO: add support for domain-wide tokens (right now it's only alias-specific)
  // `auth.username` must be an alias that exists in the system
  // `auth.password` must be domain-wide or alias-specific generated token
  // (password visible only once to user upon creation)
  //
  try {
    // check if server is in the process of shutting down
    if (this.server._closeTimeout) throw new ServerShutdownError();

    // check if socket is still connected (only applicable for IMAP)
    if (this.server instanceof IMAPServer) {
      const socket =
        (session.socket && session.socket._parent) || session.socket;
      if (!socket || socket?.destroyed || socket?.readyState !== 'open')
        throw new SocketError();
    }

    // username must be a valid email address
    if (
      typeof auth.username !== 'string' ||
      !isSANB(auth.username) ||
      !isEmail(auth.username.trim()) ||
      // <https://react.email/docs/integrations/nodemailer>
      auth.username === 'my_user' ||
      // <https://nodemailer.com/about/#example>
      auth.username === 'REPLACE-WITH-YOUR-ALIAS@YOURDOMAIN.COM'
    )
      throw new SMTPError(
        `Invalid username, please enter a valid email address (e.g. "alias@example.com"); use one of your domain's aliases at ${config.urls.web}/my-account/domains`,
        {
          responseCode: 535,
          ignoreHook: true
        }
      );

    let [name, domainName] = auth.username.trim().toLowerCase().split('@');

    domainName = punycode.toUnicode(domainName);

    // password must be a 24 character long generated string
    if (
      typeof auth.password !== 'string' ||
      !isSANB(auth.password) ||
      auth.password.length > 128 ||
      // <https://react.email/docs/integrations/nodemailer>
      auth.password === 'my_password' ||
      // <https://nodemailer.com/about/#example>
      auth.password === 'REPLACE-WITH-YOUR-GENERATED-PASSWORD'
    )
      throw new SMTPError(
        `Invalid password, please try again or go to ${config.urls.web}/my-account/domains/${domainName}/aliases and click "Generate Password"`,
        {
          responseCode: 535,
          ignoreHook: true
        }
      );

    const verifications = [];
    try {
      const records = await this.resolver.resolveTxt(domainName);
      for (const record_ of records) {
        const record = record_.join('').trim(); // join chunks together
        if (record.startsWith(config.paidPrefix))
          verifications.push(record.replace(config.paidPrefix, '').trim());
      }
    } catch (err) {
      logger.error(err, { session });
    }

    if (verifications.length === 0)
      throw new SMTPError(
        `Domain is missing TXT verification record, go to ${config.urls.web}/my-account/domains/${domainName} and click "Verify"`,
        {
          responseCode: 535,
          ignoreHook: true
        }
      );

    if (verifications.length > 1)
      throw new SMTPError(
        `Domain has more than one TXT verification record, go to ${config.urls.web}/my-account/domains/${domainName} and click "Verify"`,
        {
          responseCode: 535,
          ignoreHook: true
        }
      );

    const domain = await Domains.findOne({
      name: domainName,
      verification_record: verifications[0],
      plan: { $ne: 'free' }
    })
      .populate(
        'members.user',
        `id plan ${config.userFields.isBanned} ${config.userFields.hasVerifiedEmail} ${config.userFields.planExpiresAt}`
      )
      .lean()
      .exec();

    // validate domain
    validateDomain(domain, domainName);

    const alias = await Aliases.findOne({
      name,
      domain: domain._id
    })
      .populate(
        'user',
        `id ${config.userFields.isBanned} ${config.userFields.smtpLimit}`
      )
      .select('+tokens.hash +tokens.salt')
      .lean()
      .exec();

    // validate alias
    validateAlias(alias, domain, name);

    // validate the `auth.password` provided
    if (!Array.isArray(alias.tokens) || alias.tokens.length === 0)
      throw new SMTPError(
        `Alias does not have any generated passwords yet, go to ${config.urls.web}/my-account/domains/${domain.name}/aliases and click "Generate Password"`,
        {
          responseCode: 535,
          ignoreHook: true
        }
      );

    //
    // rate limiting
    //
    if (
      // do not rate limit IP addresses corresponding to our servers
      !session.resolvedClientHostname ||
      parseRootDomain(session.resolvedClientHostname) !== env.WEB_HOST
    ) {
      // rate limit to X failed attempts per day by IP address
      const limit = await this.rateLimiter.get({
        id: session.remoteAddress,
        max: config.smtpLimitAuth,
        duration: config.smtpLimitAuthDuration
      });

      // return 550 error code
      if (!limit.remaining)
        throw new SMTPError(
          `You have exceeded the maximum number of failed authentication attempts. Please try again later or contact us at ${config.supportEmail}`
          // { ignoreHook: true }
        );
    }

    // ensure that the token is valid
    const isValid = await Aliases.isValidPassword(
      alias.tokens,
      auth.password.trim()
    );

    if (!isValid)
      throw new SMTPError(
        `Invalid password, please try again or go to ${config.urls.web}/my-account/domains/${domainName}/aliases and click "Generate Password"`,
        {
          responseCode: 535
          // ignoreHook: true
        }
      );

    // Clear authentication limit for this IP address (in the background)
    this.client
      .del(`${this.rateLimiter.namespace}:${session.remoteAddress}`)
      .then()
      .catch((err) => this.config.logger.fatal(err));

    //
    // If this was IMAP server then ensure the user has all essential folders
    //
    if (this.server instanceof IMAPServer) {
      try {
        const paths = await Mailboxes.distinct('path', {
          alias: alias._id
        });
        const required = [];
        for (const path of REQUIRED_PATHS) {
          if (!paths.includes(path)) required.push(path);
        }

        if (required.length > 0) {
          logger.debug('creating required', { required });
          await Mailboxes.create(
            required.map((path) => ({
              alias: alias._id,
              path
            }))
          );
        }
      } catch (err) {
        logger.fatal(err, { session });
      }
    }

    // this response object sets `session.user` to have `domain` and `alias`
    // <https://github.com/nodemailer/smtp-server/blob/a570d0164e4b4ef463eeedd80cadb37d5280e9da/lib/sasl.js#L235>
    fn(null, {
      user: {
        // <https://github.com/nodemailer/wildduck/issues/510>
        id: alias.id,
        username: `${alias.name}@${domain.name}`,
        alias_id: alias.id,
        alias_name: alias.name,
        domain_id: domain.id,
        domain_name: domain.name
      }
    });
  } catch (err) {
    //
    // NOTE: we should actually share error message if it was not a code bug
    //       (otherwise it won't be intuitive to users if they're late on payment)
    //
    // <https://github.com/nodemailer/smtp-server/blob/a570d0164e4b4ef463eeedd80cadb37d5280e9da/lib/sasl.js#L189-L222>
    fn(refineAndLogError(err, session, this.server instanceof IMAPServer));
  }
}

module.exports = onAuth;