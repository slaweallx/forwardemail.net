/**
 * Copyright (c) Forward Email LLC
 * SPDX-License-Identifier: BUSL-1.1
 */

const isSANB = require('is-string-and-not-blank');

const Aliases = require('#models/aliases');
const Domains = require('#models/domains');
const IMAPError = require('#helpers/imap-error');
const ServerShutdownError = require('#helpers/server-shutdown-error');
const SocketError = require('#helpers/socket-error');
const config = require('#config');
const getDatabase = require('#helpers/get-database');
const validateAlias = require('#helpers/validate-alias');
const validateDomain = require('#helpers/validate-domain');

const IMAP_COMMANDS = new Set([
  'APPEND',
  'COPY',
  'CREATE',
  'DELETE',
  'EXPUNGE',
  'FETCH',
  'GETQUOTAROOT',
  'GETQUOTA',
  'LIST',
  'LSUB',
  'MOVE',
  'OPEN',
  'RENAME',
  'SEARCH',
  'STATUS',
  'STORE',
  'SUBSCRIBE',
  'UNSUBSCRIBE'
]);

async function refreshSession(session, command) {
  if (!command) throw new Error('Command required');
  command = command.toUpperCase().trim();
  if (!IMAP_COMMANDS.has(command)) throw new Error('Invalid command');

  // check if server is in the process of shutting down
  if (this.server._closeTimeout) throw new ServerShutdownError();

  // check if socket is still connected
  const socket = (session.socket && session.socket._parent) || session.socket;
  if (!socket || socket?.destroyed || socket?.readyState !== 'open')
    throw new SocketError();

  if (!isSANB(session?.user?.domain_id))
    throw new IMAPError('Domain does not exist on session');

  if (!isSANB(session?.user?.alias_id))
    throw new IMAPError('Alias does not exist on session');

  const [domain, alias] = await Promise.all([
    Domains.findById(session.user.domain_id)
      .populate(
        'members.user',
        `id plan ${config.userFields.isBanned} ${config.userFields.hasVerifiedEmail} ${config.userFields.planExpiresAt} ${config.userFields.stripeSubscriptionID} ${config.userFields.paypalSubscriptionID}`
      )
      .lean()
      .exec(),
    Aliases.findById(session.user.alias_id)
      .populate(
        'user',
        // TODO: we can remove `smtpLimit` (?)
        `id ${config.userFields.isBanned} ${config.userFields.smtpLimit}`
      )
      .lean()
      .exec()
  ]);

  // validate domain (in case tampered with during session)
  validateDomain(domain, session.user.domain_name);

  // validate alias (in case tampered with during session)
  validateAlias(alias, session.user.domain_name, session.user.alias_name);

  // TODO: ensure helper logger removes `session.user.password`
  // TODO: ensure all logger statements have _.omit(session, 'user.password')
  // TODO: rewrite attachment storage and everything else to use sqlite
  // TODO: flush the queue from existing -> into the Database
  // TODO: notifications via web/sms/desktop/mobile electron + react native app
  //       (e.g. if there are any issues such as IMAP access being locked due to r/w issues)
  // TODO: script to export as mbox

  // connect to the database
  const db = await getDatabase(this, alias, session);

  return { db, domain, alias };
}

module.exports = refreshSession;