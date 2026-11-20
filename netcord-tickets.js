'use strict';

const { randomUUID, createHash } = require('node:crypto');
const {
  SlashCommandBuilder, PermissionFlagsBits: P, MessageFlags: F,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle: B,
  ModalBuilder, TextInputBuilder, TextInputStyle: T, LabelBuilder,
  FileUploadBuilder, StringSelectMenuBuilder, ChannelType: C,
  OverwriteType, AttachmentBuilder,
} = require('discord.js');

const PREFIX = 'nt:';
const ADMIN = P.ManageGuild;
const PRIVATE = F.Ephemeral;
const QUIET = { parse: [] };
const READ = [P.ViewChannel, P.ReadMessageHistory];
const CHAT = [...READ, P.SendMessages, P.AttachFiles, P.EmbedLinks];
const MAX_FILE = 8 * 1024 * 1024;
const MAX_TRANSCRIPT = 1000;
const KEY = /^[a-z0-9][a-z0-9-]{0,23}$/;
const SNOWFLAKE = /^\d{17,20}$/;
const nonce = key => BigInt('0x' + createHash('sha256').update(key).digest('hex').slice(0, 16)).toString();
const id = () => randomUUID().replaceAll('-', '').slice(0, 20);
const style = { primary: B.Primary, secondary: B.Secondary, success: B.Success, danger: B.Danger };
const defaultFields = [
  { label: 'Sujet', max: 100, required: true },
  { label: 'Explique ta demande', max: 900, required: true, long: true },
];
const row = (...items) => new ActionRowBuilder().addComponents(...items);
const button = (key, label, type = B.Secondary) =>
  new ButtonBuilder().setCustomId(PREFIX + key).setLabel(label).setStyle(type);

class TicketError extends Error {}

function check(ok, message) {
  if (!ok) throw new TicketError(message);
}

function str(value, max, name, fallback = '') {
  const result = value ?? fallback;
  check(typeof result === 'string' && result.length <= max, `${name} : texte de ${max} caractères maximum.`);
  return result.trim();
}

function snowflake(value, label, required = false) {
  const result = value ?? '';
  check(typeof result === 'string' && ((!required && !result) || SNOWFLAKE.test(result)),
    `${label} : identifiant Discord invalide.`);
  return result;
}

function color(value) {
  const result = value ?? '#5865F2';
  check(typeof result === 'string' && /^#[a-f\d]{6}$/i.test(result), 'Couleur attendue au format #RRGGBB.');
  return result;
}

function normalize(source, normalizeEmbed) {
  check(source && typeof source === 'object' && !Array.isArray(source), 'Configuration JSON invalide.');
  const name = str(source.name, 80, 'name');
  check(name, 'Indique un nom de panneau dans name.');
  const category = snowflake(source.category, 'category', true);
  const archiveCategory = snowflake(source.archiveCategory, 'archiveCategory');
  const logChannel = snowflake(source.logChannel, 'logChannel');
  function roles(value, label) {
    check(Array.isArray(value) && value.length >= 1 && value.length <= 15, `${label} : de 1 à 15 rôles staff.`);
    return [...new Set(value.map(role => snowflake(role, label, true)))];
  }
  const staffRoles = roles(source.staffRoles, 'staffRoles');
  const maxOpen = source.maxOpen ?? 3;
  check(Number.isInteger(maxOpen) && maxOpen >= 1 && maxOpen <= 10, 'maxOpen : de 1 à 10 tickets ouverts par membre et par panneau.');
  const display = source.display ?? 'select';
  check(['select', 'buttons'].includes(display), 'display : select ou buttons.');
  const embedId = str(source.embedId, 32, 'embedId');
  check(!embedId || /^[a-f\d]+$/i.test(embedId), 'Identifiant du brouillon embed invalide.');
  const message = source.message ?? {
    embeds: [{ title: name, description: 'Choisis un sujet pour ouvrir un ticket.', color: 0x5865F2 }],
  };
  check(message && typeof message === 'object' && !Array.isArray(message), 'message doit contenir un objet embed.');
  let checkedMessage;
  try {
    checkedMessage = normalizeEmbed({ ...message, embeds: message.embeds ?? [] });
  } catch (error) {
    throw new TicketError(`Message du panneau : ${error.message}`);
  }
  check((checkedMessage.components?.length ?? 0) < 5, 'Laisse au moins une ligne pour les boutons ou le menu du panneau.');
  check(Array.isArray(source.topics) && source.topics.length >= 1 && source.topics.length <= 25,
    'Configure entre 1 et 25 sujets.');
  const topicIds = new Set();
  const topics = source.topics.map(topic => {
    check(topic && typeof topic === 'object', 'Sujet invalide.');
    const key = topic.id;
    check(typeof key === 'string' && KEY.test(key) && !topicIds.has(key), 'Chaque sujet doit avoir un id unique en minuscules (ex. giveaway).');
    topicIds.add(key);
    const label = str(topic.label, 45, 'topic.label');
    check(label, 'Chaque sujet doit avoir un label.');
    const fields = topic.fields ?? defaultFields;
    check(Array.isArray(fields) && fields.length >= 1 && fields.length + Number(Boolean(topic.attachment)) <= 5,
      `Sujet ${label} : de 1 à 5 éléments de formulaire, pièce jointe comprise.`);
    const topicStyle = topic.style ?? 'primary';
    check(Object.hasOwn(style, topicStyle), 'Style de bouton : primary, secondary, success ou danger.');
    const emoji = str(topic.emoji, 100, 'emoji');
    const customEmoji = /^<a?:[\w]+:(\d{17,20})>$/.exec(emoji);
    return {
      id: key, label, style: topicStyle, emoji: customEmoji ? customEmoji[1] : emoji,
      description: str(topic.description, 100, 'topic.description'),
      category: snowflake(topic.category, 'topic.category') || category,
      staffRoles: topic.staffRoles == null ? staffRoles : roles(topic.staffRoles, 'topic.staffRoles'),
      notify: topic.notify === true,
      welcome: str(topic.welcome, 500, 'topic.welcome', 'Décris ta demande ici si tu souhaites ajouter des éléments.'),
      color: color(topic.color ?? source.color),
      attachment: Boolean(topic.attachment),
      fields: fields.map(field => {
        check(field && typeof field === 'object', 'Champ de formulaire invalide.');
        const fieldLabel = str(field.label, 45, 'field.label');
        const max = field.max ?? (field.long ? 900 : 120);
        check(fieldLabel && Number.isInteger(max) && max >= 1 && max <= 900,
          'Chaque question doit avoir un titre et une longueur maximale de 1 à 900 caractères.');
        return {
          label: fieldLabel, max, required: field.required !== false, long: !!field.long,
          placeholder: str(field.placeholder, 100, 'field.placeholder'),
        };
      }),
    };
  });
  const selectPlaceholder = str(source.selectPlaceholder, 150, 'selectPlaceholder', 'Choisis le sujet de ta demande');
  check(selectPlaceholder, 'Le texte du menu ne peut pas être vide.');
  return { name, category, archiveCategory, logChannel, staffRoles, maxOpen, display,
    embedId, message: checkedMessage, selectPlaceholder, topics };
}

function openingForm(panel, topic) {
  const modal = new ModalBuilder().setCustomId(PREFIX + `submit:${panel.id}:${panel.version}:${topic.id}`)
    .setTitle(topic.label);
  topic.fields.forEach((field, index) => {
    const input = new TextInputBuilder().setCustomId(`q${index}`)
      .setStyle(field.long ? T.Paragraph : T.Short)
      .setRequired(field.required).setMaxLength(field.max);
    if (field.placeholder) input.setPlaceholder(field.placeholder);
    modal.addLabelComponents(new LabelBuilder().setLabel(field.label).setTextInputComponent(input));
  });
  if (topic.attachment) {
    modal.addLabelComponents(new LabelBuilder().setLabel('Pièce jointe (8 Mo max)')
      .setFileUploadComponent(new FileUploadBuilder().setCustomId('file')
        .setRequired(false).setMaxValues(1)));
  }
  return modal;
}

function reasonForm(action, ticket, title, required = false) {
  return new ModalBuilder().setCustomId(PREFIX + `${action}:${ticket.id}`).setTitle(title)
    .addLabelComponents(new LabelBuilder().setLabel('Motif')
      .setTextInputComponent(new TextInputBuilder().setCustomId('reason')
        .setStyle(T.Paragraph).setMaxLength(300).setRequired(required)));
}

async function uploadFile(attachment) {
  check(attachment.size <= MAX_FILE, 'La pièce jointe doit faire 8 Mo maximum.');
  const url = new URL(attachment.url);
  check(url.protocol === 'https:' && ['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname),
    'Ajoute la pièce jointe directement dans Discord.');
  let response;
  try {
    response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  } catch {
    throw new TicketError('La pièce jointe est inaccessible. Tu peux la renvoyer après l’ouverture du ticket.');
  }
  check(response.ok && response.body, 'La pièce jointe est inaccessible.');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    check(size <= MAX_FILE, 'La pièce jointe doit faire 8 Mo maximum.');
    chunks.push(Buffer.from(chunk));
  }
  const name = String(attachment.name || 'piece-jointe').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
  return new AttachmentBuilder(Buffer.concat(chunks), { name: name || 'piece-jointe' });
}

module.exports = function installTickets({ db, commands, isReady, messageBody, messagePayload, embedPayload, jsonFile }) {
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const panelRow = key => get('SELECT * FROM nt_panels WHERE id=?', key);
  const caseRow = key => get('SELECT * FROM nt_cases WHERE id=?', key);
  const guests = key => all('SELECT user FROM nt_guests WHERE ticket=? ORDER BY user', key).map(item => item.user);
  const mutexes = new Map();

  async function serial(key, action) {
    const pending = mutexes.get(key) || Promise.resolve();
    const current = pending.catch(() => {}).then(action);
    mutexes.set(key, current);
    try {
      return await current;
    } finally {
      if (mutexes.get(key) === current) mutexes.delete(key);
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS nt_panels (
      id TEXT PRIMARY KEY, config TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1, channel TEXT, message TEXT, publishing INTEGER NOT NULL DEFAULT 0,
      published_config TEXT, published_version INTEGER
    );
    CREATE TABLE IF NOT EXISTS nt_cases (
      id TEXT PRIMARY KEY, panel TEXT NOT NULL, topic TEXT NOT NULL, owner TEXT NOT NULL,
      config TEXT NOT NULL, state TEXT NOT NULL, channel TEXT UNIQUE, opened INTEGER NOT NULL,
      claimed TEXT, closed INTEGER, reason TEXT
    );
    CREATE TABLE IF NOT EXISTS nt_guests (
      ticket TEXT NOT NULL, user TEXT NOT NULL, PRIMARY KEY(ticket, user)
    );
    CREATE INDEX IF NOT EXISTS nt_case_lookup ON nt_cases(panel,owner,state);
    CREATE UNIQUE INDEX IF NOT EXISTS nt_case_open ON nt_cases(panel,topic,owner)
      WHERE state IN ('opening','open');
  `);

  const requirePanel = key => {
    const record = panelRow(key);
    check(record, 'Panneau introuvable. Utilise /ticket list pour retrouver son ID.');
    return record;
  };
  const panelConfig = record => JSON.parse(record.config);
  const caseConfig = record => JSON.parse(record.config);

  function livePanel(key, version) {
    const panel = requirePanel(key);
    check(panel.enabled && panel.message && String(panel.published_version) === version,
      'Ce panneau a changé ou est suspendu. Réessaie depuis le dernier panneau publié.');
    return { ...panel, config: panel.published_config, version: panel.published_version };
  }

  const command = new SlashCommandBuilder().setName('ticket')
    .setDescription('Configurer et gérer les tickets Netcord');
  const sub = (name, description, options = s => s) => command.addSubcommand(s => options(s.setName(name).setDescription(description)));
  const panelId = s => s.addStringOption(o => o.setName('id').setDescription('ID du panneau visible avec /ticket list').setRequired(true));
  const file = (s, required) => s.addAttachmentOption(o => o.setName('fichier').setDescription('Configuration JSON du panneau').setRequired(required));
  const category = (s, required) => s.addChannelOption(o => o.setName('categorie').setDescription('Catégorie Discord où créer les tickets')
    .addChannelTypes(C.GuildCategory).setRequired(required));
  sub('create', 'Créer un panneau avec un formulaire de support', s => category(s, true)
    .addRoleOption(o => o.setName('staff').setDescription('Rôle qui peut voir et gérer les tickets').setRequired(true))
    .addStringOption(o => o.setName('nom').setDescription('Nom du panneau').setMaxLength(80).setRequired(true)));
  sub('configure', 'Importer, remplacer ou exporter une configuration JSON', s => file(s, false)
    .addStringOption(o => o.setName('id').setDescription('Avec un fichier, remplace ce panneau. Sans fichier, exporte sa configuration.')));
  sub('topic', 'Ajouter ou modifier un sujet avec un formulaire par défaut', s => category(panelId(s)
    .addStringOption(o => o.setName('cle').setDescription('Clé du sujet, par exemple giveaway').setRequired(true).setMaxLength(24))
    .addStringOption(o => o.setName('nom').setDescription('Nom affiché').setRequired(true).setMaxLength(45)), false)
    .addRoleOption(o => o.setName('staff').setDescription('Rôle staff spécifique à ce sujet'))
    .addStringOption(o => o.setName('description').setDescription('Description affichée dans le menu').setMaxLength(100)));
  sub('list', 'Lister les panneaux');
  sub('preview', 'Prévisualiser un panneau', panelId);
  sub('publish', 'Publier ou mettre à jour un panneau', s => panelId(s)
    .addChannelOption(o => o.setName('salon').setDescription('Salon cible à la première publication').addChannelTypes(C.GuildText, C.GuildAnnouncement))
    .addStringOption(o => o.setName('message').setDescription('ID du message existant à rattacher après un envoi incertain'))
    .addBooleanOption(o => o.setName('relancer').setDescription('Relancer un envoi incertain après vérification du salon')));
  sub('disable', 'Suspendre les nouvelles demandes d’un panneau', panelId);
  sub('claim', 'Prendre en charge ce ticket');
  sub('unclaim', 'Libérer ce ticket');
  sub('add', 'Ajouter un membre au ticket', s => s.addUserOption(o => o.setName('membre').setDescription('Membre à ajouter').setRequired(true)));
  sub('remove', 'Retirer un membre ajouté au ticket', s => s.addUserOption(o => o.setName('membre').setDescription('Membre à retirer').setRequired(true)));
  sub('close', 'Fermer ce ticket');
  sub('reopen', 'Rouvrir ce ticket');
  sub('transcript', 'Télécharger la transcription de ce ticket');
  sub('delete', 'Supprimer définitivement un ticket fermé');
  commands.push(command);

  function admin(i) {
    check(i.memberPermissions?.has(ADMIN), 'Cette action demande la permission Gérer le serveur.');
  }

  function staff(i, ticket) {
    const roles = i.member?.roles;
    return i.memberPermissions?.has(P.Administrator) ||
      caseConfig(ticket).staffRoles.some(role => roles?.cache?.has(role) || (Array.isArray(roles) && roles.includes(role)));
  }

  async function channel(guild, key, type, required = true) {
    if (!key && !required) return null;
    const result = await guild.channels.fetch(key);
    check(result?.type === type, 'Salon ou catégorie introuvable sur ce serveur.');
    return result;
  }

  function checkBot(parent, guild) {
    const me = guild.members.me;
    check(me && parent.permissionsFor(me)?.has([P.ViewChannel, P.ManageChannels, P.ManageRoles]),
      'Le bot doit pouvoir voir la catégorie, gérer les salons et gérer les permissions.');
  }

  async function validateRouting(guild, config) {
    const guildRoles = await guild.roles.fetch();
    for (const role of new Set([...config.staffRoles, ...config.topics.flatMap(topic => topic.staffRoles)])) {
      check(role !== guild.id && guildRoles.has(role), `Rôle staff invalide : ${role}.`);
    }
    const categories = new Set([config.category, config.archiveCategory, ...config.topics.map(topic => topic.category)].filter(Boolean));
    for (const key of categories) checkBot(await channel(guild, key, C.GuildCategory), guild);
    if (config.logChannel) {
      const log = await channel(guild, config.logChannel, C.GuildText);
      check(!log.permissionsFor(guild.roles.everyone)?.has(P.ViewChannel),
        'Le salon de logs doit être masqué à @everyone.');
      check(log.permissionsFor(guild.members.me)?.has([P.ViewChannel, P.SendMessages]),
        'Le bot doit pouvoir écrire dans le salon de logs.');
    }
  }

  function controlRows(panel, config, disabled, linkRowCount) {
    const key = `open:${panel.id}:${panel.version}`;
    if (config.display === 'select') {
      const menu = new StringSelectMenuBuilder().setCustomId(PREFIX + key)
        .setPlaceholder(config.selectPlaceholder).setDisabled(disabled)
        .addOptions(config.topics.map(topic => ({
          label: topic.label, value: topic.id,
          ...(topic.description && { description: topic.description }),
          ...(topic.emoji && { emoji: topic.emoji }),
        })));
      return [row(menu)];
    }
    check(Math.ceil(config.topics.length / 5) + linkRowCount <= 5, 'Maximum 5 rangées de boutons en comptant les liens du panneau.');
    const buttons = config.topics.map(topic => {
      const item = button(`${key}:${topic.id}`, topic.label, style[topic.style]).setDisabled(disabled);
      if (topic.emoji) item.setEmoji(topic.emoji);
      return item;
    });
    const rows = [];
    for (let start = 0; start < buttons.length; start += 5) rows.push(row(...buttons.slice(start, start + 5)));
    return rows;
  }

  function panelPayload(panel, disabled = false) {
    const config = panelConfig(panel);
    const payload = config.embedId ? embedPayload(config.embedId) : messagePayload(config.message);
    const controls = controlRows(panel, config, disabled, payload.components.length);
    return { ...payload, components: [...payload.components, ...controls], allowedMentions: QUIET };
  }

  async function publish(i, key) {
    const panel = requirePanel(key);
    await validateRouting(i.guild, panelConfig(panel));
    const chosen = i.options.getChannel('salon')?.id;
    const reattach = i.options.getString('message');
    const retry = i.options.getBoolean('relancer');
    check(!chosen || !panel.channel || chosen === panel.channel,
      'Ce panneau est lié à un salon. Crée un autre panneau pour publier ailleurs.');
    const targetId = panel.channel || chosen;
    check(targetId, 'Choisis le salon de publication.');
    const target = await i.guild.channels.fetch(targetId);
    check(target && [C.GuildText, C.GuildAnnouncement].includes(target.type), 'Salon de publication invalide.');
    const payload = panelPayload(panel);
    if (panel.message || reattach) {
      check(!reattach || !panel.message || reattach === panel.message, 'Ce panneau possède déjà un message lié.');
      const message = await target.messages.fetch(reattach || panel.message).catch(error => {
        if (error.code !== 10008) throw error;
        return null;
      });
      if (message) {
        const bound = message.components.some(line => line.components.some(component =>
          component.customId?.startsWith(PREFIX + `open:${key}:`)));
        check(message.author.id === i.client.user.id && bound, 'Ce message ne correspond pas à ce panneau.');
        await message.edit(payload);
        run('UPDATE nt_panels SET enabled=1, channel=?, message=?, publishing=0, published_config=?, published_version=? WHERE id=?',
          target.id, message.id, panel.config, panel.version, key);
        return i.editReply(`Panneau mis à jour · ${message.url}`);
      }
      check(!reattach, 'Le message à rattacher a été introuvable.');
      run('UPDATE nt_panels SET message=NULL, publishing=0 WHERE id=?', key);
    } else {
      check(!panel.publishing || retry, 'Envoi incertain. Rattache le message existant ou utilise relancer après avoir vérifié le salon.');
      if (panel.publishing && retry) {
        const messages = await target.messages.fetch({ limit: 100 });
        check(!messages.some(message => message.author.id === i.client.user.id &&
          message.components.some(line => line.components.some(component =>
            component.customId?.startsWith(PREFIX + `open:${key}:`)))),
          'Un panneau existe déjà dans ce salon. Indique son ID avec l’option message.');
      }
    }

    run('UPDATE nt_panels SET channel=?, publishing=1 WHERE id=?', target.id, key);
    let sent;
    try {
      sent = await target.send({ ...payload, nonce: nonce(`panel:${key}:${panel.version}`), enforceNonce: true });
    } catch (error) {
      if (error.status >= 400 && error.status < 500 && error.status !== 429) {
        run('UPDATE nt_panels SET publishing=0 WHERE id=?', key);
      }
      throw error;
    }
    run('UPDATE nt_panels SET enabled=1, message=?, publishing=0, published_config=?, published_version=? WHERE id=?',
      sent.id, panel.config, panel.version, key);
    return i.editReply(`Panneau publié · ${sent.url}`);
  }

  function overwriteList(guild, ticket, closed, guestIds = []) {
    const config = caseConfig(ticket);
    return [
      { id: guild.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
      { id: guild.members.me.id, type: OverwriteType.Member, allow: [...CHAT, P.ManageChannels, P.ManageRoles] },
      ...config.staffRoles.map(id => ({ id, type: OverwriteType.Role, allow: CHAT })),
      ...[ticket.owner, ...guestIds].map(id => ({
        id, type: OverwriteType.Member, ...(closed ? { deny: [P.ViewChannel] } : { allow: CHAT }),
      })),
    ];
  }

  async function audit(guild, ticket, actor, action) {
    const { logChannel } = caseConfig(ticket);
    if (!logChannel) return;
    try {
      const target = await channel(guild, logChannel, C.GuildText);
      if (target.permissionsFor(guild.roles.everyone)?.has(P.ViewChannel)) return;
      await target.send({
        content: `**Ticket ${ticket.id}** · ${action} · <@${actor}>${ticket.channel ? ` · <#${ticket.channel}>` : ''}`,
        allowedMentions: QUIET,
      });
    } catch (error) {
      console.warn('Ticket audit:', error.code || error.name);
    }
  }

  function ticketControls(ticket) {
    return [
      row(button(`claim:${ticket.id}`, 'Prendre en charge', B.Primary),
        button(`close:${ticket.id}`, 'Fermer', B.Danger),
        button(`reopen:${ticket.id}`, 'Rouvrir'),
        button(`transcript:${ticket.id}`, 'Transcription')),
    ];
  }

  function reserve(panel, config, topic, owner) {
    const active = get(`SELECT * FROM nt_cases WHERE panel=? AND topic=? AND owner=? AND state IN ('opening','open')`, panel.id, topic.id, owner);
    if (active) return active;
    const { n } = get(`SELECT count(*) AS n FROM nt_cases WHERE panel=? AND owner=? AND state IN ('opening','open')`, panel.id, owner);
    check(n < config.maxOpen, `Tu peux avoir jusqu’à ${config.maxOpen} ticket(s) ouvert(s) sur ce panneau.`);
    const key = id();
    const snapshot = { ...topic, archiveCategory: config.archiveCategory, logChannel: config.logChannel, maxOpen: config.maxOpen };
    run('INSERT INTO nt_cases(id,panel,topic,owner,config,state,opened) VALUES (?,?,?,?,?,?,?)',
      key, panel.id, topic.id, owner, JSON.stringify(snapshot), 'opening', Date.now());
    return caseRow(key);
  }

  async function createTicket(i, panel, topic, answers, attachment) {
    const config = panelConfig(panel);
    return serial(`owner:${panel.id}:${i.user.id}`, async () => {
      const current = livePanel(panel.id, String(panel.version));
      let ticket = reserve(current, config, topic, i.user.id);
      if (ticket.state === 'open') {
        const existing = await i.guild.channels.fetch(ticket.channel).catch(error => {
          if (error.code === 10003) return null;
          throw error;
        });
        if (existing) return i.editReply(`Tu as déjà un ticket pour ce sujet : <#${existing.id}>.`);
        run("UPDATE nt_cases SET state='deleted' WHERE id=?", ticket.id);
        ticket = reserve(current, config, topic, i.user.id);
      }
      const routing = caseConfig(ticket);
      const marker = `Netcord ticket ${ticket.id}`;
      const listed = await i.guild.channels.fetch();
      let target = listed.find(c => c?.type === C.GuildText && c.topic === marker);
      try {
        const files = attachment ? [await uploadFile(attachment)] : [];
        if (!target) {
          const parent = await channel(i.guild, routing.category, C.GuildCategory);
          checkBot(parent, i.guild);
          const name = i.user.username.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 30);
          target = await i.guild.channels.create({
            name: `${topic.id}-${name || 'ticket'}-${ticket.id.slice(0, 6)}`, type: C.GuildText,
            parent: parent.id, topic: marker, permissionOverwrites: overwriteList(i.guild, ticket, false),
            reason: 'Netcord ticket ' + ticket.id,
          });
        }
        run('UPDATE nt_cases SET channel=? WHERE id=?', target.id, ticket.id);
        // Reapply privacy before using a channel recovered after an interrupted create.
        await target.permissionOverwrites.set(overwriteList(i.guild, ticket, false));
        const staffMentions = routing.notify ? routing.staffRoles.map(role => `<@&${role}>`).join(' ') : '';
        const details = new EmbedBuilder().setTitle(topic.label).setColor(topic.color)
          .setDescription([`Demande de <@${ticket.owner}>`, topic.welcome].filter(Boolean).join('\n\n'))
          .addFields(topic.fields.map((field, index) => ({ name: field.label, value: answers[index] || '—' })))
          .setFooter({ text: `Ticket ${ticket.id}` });
        const recent = await target.messages.fetch({ limit: 50 });
        const header = recent.find(message => message.author.id === i.client.user.id &&
          message.embeds.some(embed => embed.footer?.text === `Ticket ${ticket.id}`));
        if (!header) await target.send({
          content: [`<@${ticket.owner}>`, staffMentions].filter(Boolean).join(' '),
          embeds: [details], components: ticketControls(ticket), files,
          allowedMentions: { parse: [], users: [ticket.owner], roles: routing.notify ? routing.staffRoles : [] },
          nonce: nonce(`ticket:${ticket.id}`), enforceNonce: true,
        });
        run("UPDATE nt_cases SET state='open' WHERE id=?", ticket.id);
      } catch (error) {
        const definite = error instanceof TicketError || (error.status >= 400 && error.status < 500 && error.status !== 429);
        if (!target && definite) run("DELETE FROM nt_cases WHERE id=? AND state='opening' AND channel IS NULL", ticket.id);
        throw error;
      }
      await i.editReply(`Ton ticket est ouvert : <#${target.id}>.`);
      await audit(i.guild, { ...ticket, channel: target.id }, i.user.id, 'Ouvert');
    });
  }

  function resolveCase(i, key) {
    const record = key ? caseRow(key) : get('SELECT * FROM nt_cases WHERE channel=?', i.channelId);
    check(record?.channel === i.channelId && !['opening', 'deleted'].includes(record.state),
      'Utilise cette commande dans un salon de ticket.');
    return record;
  }

  async function transcript(i, ticket, target) {
    const messages = [];
    let before;
    while (messages.length < MAX_TRANSCRIPT) {
      const page = await target.messages.fetch({ limit: 100, ...(before && { before }), cache: false });
      if (!page.size) break;
      messages.push(...page.values());
      if (page.size < 100) break;
      before = page.lastKey();
    }
    const entries = messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp).map(message => ({
      at: new Date(message.createdTimestamp).toISOString(),
      author: message.author.username,
      user: message.author.id,
      message: message.id,
      content: message.content,
      embeds: message.embeds.map(embed => embed.toJSON()),
      attachments: [...message.attachments.values()].map(file => ({ name: file.name, url: file.url })),
    }));
    const contents = { ticket: ticket.id, owner: ticket.owner, subject: ticket.topic,
      state: ticket.state, reason: ticket.reason, capped: messages.length >= MAX_TRANSCRIPT, messages: entries };
    const data = Buffer.from(JSON.stringify(contents, null, 2));
    check(data.length <= MAX_FILE, 'La transcription dépasse 8 Mo. Télécharge les messages nécessaires avant de supprimer le salon.');
    return i.editReply({ content: `Transcription privée · ${entries.length} message(s).`,
      files: [new AttachmentBuilder(data, { name: `ticket-${ticket.id}.json` })] });
  }

  async function manage(i, action, key) {
    const current = resolveCase(i, key);
    const allowed = ticket => staff(i, ticket) || (action === 'close' && ticket.owner === i.user.id);
    check(allowed(current), 'Cette action est réservée au staff de ce ticket.');
    if (['close', 'delete'].includes(action) && !i.isModalSubmit()) {
      check(current.state === (action === 'close' ? 'open' : 'closed'),
        action === 'close' ? 'Ce ticket est déjà fermé.' : 'Ferme le ticket avant de le supprimer.');
      return i.showModal(reasonForm(action, current, action === 'close' ? 'Fermer le ticket' : 'Supprimer définitivement', action === 'delete'));
    }
    await i.deferReply({ flags: PRIVATE });
    return serial(`owner:${current.panel}:${current.owner}`, async () => {
      const ticket = resolveCase(i, current.id);
      check(allowed(ticket), 'Cette action est réservée au staff de ce ticket.');
      const target = i.channel || await channel(i.guild, ticket.channel, C.GuildText);
      const config = caseConfig(ticket);
      if (action === 'transcript') return transcript(i, ticket, target);
      const reason = i.isModalSubmit() ? i.fields.getTextInputValue('reason').trim() : '';
      let response;
      let event;
      if (action === 'claim' || action === 'unclaim') {
        check(ticket.state === 'open', 'Ce ticket est fermé.');
        if (action === 'claim') {
          check(!ticket.claimed || ticket.claimed === i.user.id, 'Ce ticket est déjà pris en charge.');
          if (ticket.claimed === i.user.id) return i.editReply('Tu as déjà pris ce ticket en charge.');
        } else {
          check(ticket.claimed && (ticket.claimed === i.user.id || i.memberPermissions?.has(ADMIN)),
            'Seule la personne qui a pris le ticket ou un admin peut le libérer.');
        }
        run('UPDATE nt_cases SET claimed=? WHERE id=?', action === 'claim' ? i.user.id : null, ticket.id);
        event = action === 'claim' ? 'Pris en charge' : 'Remis en file';
        response = action === 'claim' ? 'Tu as pris ce ticket en charge.' : 'Ticket remis en file.';
        await target.send({ content: `${event} par <@${i.user.id}>.`, allowedMentions: QUIET }).catch(error =>
          console.warn('Ticket claim notice:', error.code || error.name));
      } else if (action === 'add' || action === 'remove') {
        check(ticket.state === 'open', 'Rouvre le ticket avant de modifier les participants.');
        const user = i.options.getUser('membre', true);
        check(!user.bot && user.id !== ticket.owner, 'Choisis un membre autre que la personne qui a ouvert le ticket.');
        const existing = guests(ticket.id);
        if (action === 'add') {
          check(!existing.includes(user.id) && existing.length < 20, 'Membre déjà ajouté ou limite de 20 invités atteinte.');
          const member = await i.guild.members.fetch(user.id).catch(error => {
            if (error.code === 10007) return null;
            throw error;
          });
          check(member, 'Ce membre ne fait pas partie du serveur.');
          await target.permissionOverwrites.set(overwriteList(i.guild, ticket, false, [...existing, user.id]));
          run('INSERT INTO nt_guests(ticket,user) VALUES (?,?)', ticket.id, user.id);
        } else {
          check(existing.includes(user.id), 'Ce membre ne fait pas partie des invités du ticket.');
          await target.permissionOverwrites.set(overwriteList(i.guild, ticket, false, existing.filter(id => id !== user.id)));
          run('DELETE FROM nt_guests WHERE ticket=? AND user=?', ticket.id, user.id);
        }
        event = `${action === 'add' ? 'Invité ajouté' : 'Invité retiré'} (<@${user.id}>)`;
        response = action === 'add' ? 'Membre ajouté.' : 'Membre retiré.';
      } else if (action === 'close' || action === 'reopen') {
        const closed = action === 'close';
        check(ticket.state === (closed ? 'open' : 'closed'), closed ? 'Ce ticket est déjà fermé.' : 'Ce ticket est déjà ouvert.');
        if (!closed) {
          const active = all(`SELECT topic FROM nt_cases WHERE panel=? AND owner=? AND state IN ('opening','open')`, ticket.panel, ticket.owner);
          check(!active.some(item => item.topic === ticket.topic), 'La personne a déjà un autre ticket actif sur ce sujet.');
          check(active.length < config.maxOpen, 'Cette personne a déjà atteint la limite de tickets ouverts.');
        }
        const destination = closed ? config.archiveCategory : config.category;
        if (destination && target.parentId !== destination) {
          const parent = await channel(i.guild, destination, C.GuildCategory);
          checkBot(parent, i.guild);
        }
        await target.permissionOverwrites.set(overwriteList(i.guild, ticket, closed, guests(ticket.id)));
        run('UPDATE nt_cases SET state=?, closed=?, reason=?, claimed=NULL WHERE id=?',
          closed ? 'closed' : 'open', closed ? Date.now() : null, reason || null, ticket.id);
        let archiveError = false;
        if (destination && target.parentId !== destination) {
          try {
            await target.setParent(destination, { lockPermissions: false });
          } catch (error) {
            archiveError = true;
            console.warn('Ticket move:', error.code || error.name);
          }
        }
        event = closed ? 'Fermé' : 'Rouvert';
        response = `Ticket ${event.toLowerCase()}.${archiveError ? ' Le déplacement a échoué, le salon est resté dans sa catégorie actuelle.' : ''}`;
      } else if (action === 'delete') {
        check(ticket.state === 'closed' && reason, 'Ferme le ticket et indique un motif avant de le supprimer.');
        await target.delete(`Netcord ticket ${ticket.id}: ${reason}`);
        run("UPDATE nt_cases SET state='deleted', reason=? WHERE id=?", reason, ticket.id);
        await audit(i.guild, ticket, i.user.id, 'Supprimé');
        return i.editReply('Ticket supprimé.').catch(() => {});
      } else {
        throw new TicketError('Action de ticket inconnue.');
      }
      await i.editReply(response);
      await audit(i.guild, ticket, i.user.id, event);
    });
  }

  async function configure(i, action) {
    admin(i);
    await i.deferReply({ flags: PRIVATE });
    const options = i.options;
    const key = options.getString('id');
    if (action === 'list') {
      const panels = all('SELECT * FROM nt_panels ORDER BY rowid DESC');
      const lines = panels.map(panel => `${panel.id} · ${panelConfig(panel).name} · ${panel.enabled ? 'actif' : 'suspendu'} · ${panel.message ? `https://discord.com/channels/${i.guildId}/${panel.channel}/${panel.message}` : 'brouillon'}`);
      const content = lines.join('\n');
      if (content.length <= 1800) return i.editReply({ content: content || 'Aucun panneau.', allowedMentions: QUIET });
      return i.editReply({ content: `${panels.length} panneaux.`,
        files: [new AttachmentBuilder(Buffer.from(content), { name: 'panneaux-tickets.txt' })] });
    }
    if (action === 'create') {
      const name = options.getString('nom', true);
      const config = normalize({
        name, category: options.getChannel('categorie', true).id,
        staffRoles: [options.getRole('staff', true).id],
        topics: [{ id: 'support', label: 'Support' }],
      }, messageBody);
      await validateRouting(i.guild, config);
      const key = id();
      run('INSERT INTO nt_panels(id,config) VALUES (?,?)', key, JSON.stringify(config));
      return i.editReply(`Panneau créé · ID : \`${key}\`. Ajoute des sujets avec /ticket topic, puis publie avec /ticket publish.`);
    }
    if (action === 'configure' && !key) {
      const attachment = options.getAttachment('fichier');
      check(attachment, 'Joins un fichier JSON ou renseigne l’ID d’un panneau à exporter.');
      const config = normalize(await jsonFile(attachment), messageBody);
      await validateRouting(i.guild, config);
      const newKey = id();
      panelPayload({ id: newKey, config: JSON.stringify(config), version: 1 });
      run('INSERT INTO nt_panels(id,config) VALUES (?,?)', newKey, JSON.stringify(config));
      return i.editReply(`Panneau importé · ID : \`${newKey}\`.`);
    }
    return serial(`panel:${key}`, async () => {
      const panel = requirePanel(key);
      if (action === 'preview') return i.editReply(panelPayload(panel, true));
      if (action === 'publish') return publish(i, key);
      if (action === 'disable') {
        run('UPDATE nt_panels SET enabled=0 WHERE id=?', key);
        return i.editReply('Panneau suspendu. Les tickets existants restent accessibles. Utilise /ticket publish pour le réactiver.');
      }
      const attachment = action === 'configure' ? options.getAttachment('fichier') : null;
      if (action === 'configure' && !attachment) return i.editReply({
        files: [new AttachmentBuilder(Buffer.from(JSON.stringify(panelConfig(panel), null, 2)), { name: `panneau-${key}.json` })],
      });
      let source;
      if (attachment) {
        source = await jsonFile(attachment);
      } else {
        source = panelConfig(panel);
        const topicKey = options.getString('cle', true);
        const existing = source.topics.find(topic => topic.id === topicKey);
        const role = options.getRole('staff')?.id;
        const updated = {
          ...existing, id: topicKey, label: options.getString('nom', true),
          category: options.getChannel('categorie')?.id || existing?.category,
          staffRoles: role ? [role] : existing?.staffRoles,
          description: options.getString('description') ?? existing?.description,
        };
        source.topics = existing ? source.topics.map(topic => topic.id === topicKey ? updated : topic)
          : [...source.topics, updated];
      }
      const config = normalize(source, messageBody);
      await validateRouting(i.guild, config);
      const serialized = JSON.stringify(config);
      panelPayload({ ...panel, config: serialized, version: panel.version + 1 });
      run('UPDATE nt_panels SET config=?, version=version+1 WHERE id=?', serialized, key);
      return i.editReply(`Panneau enregistré · ID : \`${key}\`. Utilise /ticket publish pour appliquer la configuration au message.`);
    });
  }

  const configuration = new Set(['create', 'configure', 'topic', 'list', 'preview', 'publish', 'disable']);
  const management = new Set(['claim', 'unclaim', 'add', 'remove', 'close', 'reopen', 'transcript', 'delete']);
  function handles(i) {
    return i.isChatInputCommand() ? i.commandName === 'ticket' : Boolean(i.customId?.startsWith(PREFIX));
  }

  async function handle(i) {
    try {
      check(isReady(), 'Le bot démarre. Réessaie dans un instant.');
      if (i.isChatInputCommand()) {
        const action = i.options.getSubcommand();
        return await (configuration.has(action) ? configure(i, action) : manage(i, action));
      }
      const [, action, key, version, topicKey] = i.customId.split(':');
      if (management.has(action)) return await manage(i, action, key);
      check(action === 'open' || action === 'submit', 'Action inconnue.');
      const panel = livePanel(key, version);
      const topic = panelConfig(panel).topics.find(topic => topic.id === (topicKey || i.values?.[0]));
      check(topic, 'Ce sujet n’est plus disponible.');
      if (action === 'open') {
        check(i.message?.id === panel.message, 'Ouvre ton ticket depuis le panneau publié.');
        return await i.showModal(openingForm(panel, topic));
      }
      await i.deferReply({ flags: PRIVATE });
      const answers = topic.fields.map((field, index) => {
        const answer = i.fields.getTextInputValue(`q${index}`).trim();
        check(answer.length <= field.max && (answer || !field.required), `Vérifie la réponse à « ${field.label} ».`);
        return answer;
      });
      const attachment = topic.attachment ? i.fields.getUploadedFiles('file')?.first() : null;
      return await createTicket(i, panel, topic, answers, attachment);
    } catch (error) {
      const content = error instanceof TicketError ? error.message : 'L’action a échoué. Vérifie la configuration et les permissions du bot, puis réessaie.';
      if (!(error instanceof TicketError)) console.warn('Netcord tickets:', error.code || error.name);
      try {
        if (i.deferred) await i.editReply({ content, allowedMentions: QUIET });
        else if (!i.replied) await i.reply({ content, flags: PRIVATE, allowedMentions: QUIET });
      } catch (replyError) {
        console.warn('Ticket reply:', replyError.code || replyError.name);
      }
    }
  }

  return { handles, handle };
};
