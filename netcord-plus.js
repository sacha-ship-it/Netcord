'use strict';

const { randomUUID, createHash } = require('node:crypto');
const {
  SlashCommandBuilder, PermissionFlagsBits: P, MessageFlags: F,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle: B,
  ModalBuilder, TextInputBuilder, TextInputStyle: T,
  StringSelectMenuBuilder, ChannelType: C, AttachmentBuilder,
} = require('discord.js');

module.exports = function install(ctx) {
  const { db, client, guildId, commands, add, transaction, task, isReady, importAsset } = ctx;
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const id = () => randomUUID().replaceAll('-', '').slice(0, 16);
  const copy = x => structuredClone(x);
  const quiet = { parse: [] };
  const color = 0x5865f2;
  const nowSql = "CAST(unixepoch('subsec')*1000 AS INTEGER)";
  function check(ok, message) { if (!ok) throw new Error(message); }
  function admin(i) { check(i.memberPermissions?.has(P.ManageGuild), 'Manage Server permission required.'); }
  function url(value) {
    if (!value) return undefined;
    const u = new URL(value);
    check(u.protocol === 'https:' && !u.username && !u.password, 'Use an HTTPS URL.');
    return u.href;
  }
  function iso(value) {
    check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/.test(value), 'Use ISO with offset: 2026-11-20T18:00:00+01:00');
    const t = Date.parse(value); check(Number.isFinite(t), 'Invalid date.'); return t;
  }
  const row = (...items) => new ActionRowBuilder().addComponents(items);
  const button = (key, label, style = B.Secondary) => new ButtonBuilder().setCustomId(key).setLabel(label).setStyle(style);
  function form(key, title, fields) {
    return new ModalBuilder().setCustomId(key).setTitle(title).addComponents(...fields.map(f => {
      const input = new TextInputBuilder().setCustomId(f[0]).setLabel(f[1]).setStyle(f[2] || T.Short).setRequired(Boolean(f[4])).setMaxLength(f[5] || 4000);
      if (f[3]) input.setValue(String(f[3]).slice(0, f[5] || 4000));
      return row(input);
    }));
  }
  const value = (i, key) => i.fields.getTextInputValue(key).trim();
  const base = (name, description, restricted = true) => {
    const c = new SlashCommandBuilder().setName(name).setDescription(description);
    if (restricted) c.setDefaultMemberPermissions(P.ManageGuild);
    return c;
  };
  const optId = s => s.addStringOption(o => o.setName('id').setDescription('ID from the list or editor').setRequired(true));
  const optChannel = s => s.addChannelOption(o => o.setName('channel').setDescription('Target channel').setRequired(true).addChannelTypes(C.GuildText, C.GuildAnnouncement));
  const optFile = s => s.addAttachmentOption(o => o.setName('file').setDescription('JSON file').setRequired(true));

  db.exec(`
    CREATE TABLE IF NOT EXISTS nx_posts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'draft',
      channel TEXT, message TEXT, due INTEGER, sent INTEGER, note TEXT,
      role TEXT, attempt TEXT
    );
    CREATE TABLE IF NOT EXISTS nx_seasons (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, start INTEGER NOT NULL,
      end INTEGER NOT NULL, closed INTEGER NOT NULL DEFAULT 0,
      board_channel TEXT, board_message TEXT
    );
    CREATE TABLE IF NOT EXISTS nx_season_points (
      season TEXT NOT NULL, user TEXT NOT NULL, xp INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(season,user)
    );
    CREATE TABLE IF NOT EXISTS nx_quizzes (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, questions TEXT NOT NULL,
      seconds INTEGER NOT NULL, reward INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'draft', channel TEXT, message TEXT
    );
    CREATE TABLE IF NOT EXISTS nx_attempts (
      quiz TEXT NOT NULL, user TEXT NOT NULL, step INTEGER NOT NULL DEFAULT 0,
      score INTEGER NOT NULL DEFAULT 0, correct INTEGER NOT NULL DEFAULT 0,
      deadline INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0,
      started INTEGER NOT NULL, PRIMARY KEY(quiz,user)
    );
    CREATE TRIGGER IF NOT EXISTS nx_track_xp_update AFTER UPDATE OF xp ON users
    WHEN NEW.xp != OLD.xp BEGIN
      INSERT INTO nx_season_points(season,user,xp)
      SELECT id,NEW.id,MAX(0,NEW.xp-OLD.xp) FROM nx_seasons
      WHERE closed=0 AND start<=${nowSql} AND end>${nowSql}
      ON CONFLICT(season,user) DO UPDATE SET xp=MAX(0,xp+NEW.xp-OLD.xp);
    END;
    CREATE TRIGGER IF NOT EXISTS nx_track_xp_insert AFTER INSERT ON users
    WHEN NEW.xp>0 BEGIN
      INSERT INTO nx_season_points(season,user,xp)
      SELECT id,NEW.id,NEW.xp FROM nx_seasons
      WHERE closed=0 AND start<=${nowSql} AND end>${nowSql}
      ON CONFLICT(season,user) DO UPDATE SET xp=xp+NEW.xp;
    END;
  `);
  // An interrupted send must be checked by a staff member, never blindly retried.
  run("UPDATE nx_posts SET state='uncertain',note='Interrupted send. Check the channel and use /embed resolve.' WHERE state='sending'");
  run("UPDATE nx_quizzes SET state='uncertain' WHERE state='sending'");

  const embedCommand = base('embed', 'Create, edit and schedule real embeds')
    .addSubcommand(s => s.setName('create').setDescription('Create a draft').addStringOption(o => o.setName('name').setDescription('Internal name').setRequired(true).setMaxLength(80)))
    .addSubcommand(s => optId(s.setName('edit').setDescription('Open the visual editor')))
    .addSubcommand(s => s.setName('list').setDescription('List drafts, publications and schedules'))
    .addSubcommand(s => optFile(s.setName('import').setDescription('Import a Discord or Discohook JSON message')).addStringOption(o => o.setName('name').setDescription('Internal name').setRequired(true).setMaxLength(80)))
    .addSubcommand(s => optId(s.setName('export').setDescription('Export a draft as JSON')))
    .addSubcommand(s => optChannel(optId(s.setName('publish').setDescription('Publish, or update the same published message'))).addRoleOption(o => o.setName('notify').setDescription('Optional role ping on first publication only')))
    .addSubcommand(s => optChannel(optId(s.setName('schedule').setDescription('Schedule a draft announcement'))).addStringOption(o => o.setName('at').setDescription('ISO, e.g. 2026-11-20T18:00:00+01:00').setRequired(true)).addRoleOption(o => o.setName('notify').setDescription('Optional role ping')))
    .addSubcommand(s => optId(s.setName('cancel').setDescription('Cancel a scheduled publication')))
    .addSubcommand(s => optId(s.setName('image').setDescription('Upload a durable embed image')).addAttachmentOption(o => o.setName('file').setDescription('PNG, JPG, WEBP or GIF').setRequired(true)).addIntegerOption(o => o.setName('number').setDescription('Embed number, default 1').setMinValue(1).setMaxValue(10)).addBooleanOption(o => o.setName('thumbnail').setDescription('Use as thumbnail instead of large image')))
    .addSubcommand(s => optId(s.setName('resolve').setDescription('Link an interrupted send to its existing Discord message')).addStringOption(o => o.setName('message').setDescription('Message ID in the configured channel').setRequired(true)))
    .addSubcommand(s => optId(s.setName('copy').setDescription('Duplicate into a new draft')));
  const quizCommand = base('quiz', 'Create and manage quizzes')
    .addSubcommand(s => optFile(s.setName('create').setDescription('Import questions from a JSON file')).addStringOption(o => o.setName('title').setDescription('Quiz title').setRequired(true).setMaxLength(180)).addIntegerOption(o => o.setName('seconds').setDescription('Seconds per question, default 15').setMinValue(5).setMaxValue(120)).addIntegerOption(o => o.setName('xp').setDescription('XP once for completing the quiz, default 75').setMinValue(0).setMaxValue(100000)))
    .addSubcommand(s => optChannel(optId(s.setName('publish').setDescription('Publish the participation button'))))
    .addSubcommand(s => optId(s.setName('close').setDescription('Close a quiz')))
    .addSubcommand(s => s.setName('list').setDescription('List quizzes'))
    .addSubcommand(s => optId(s.setName('results').setDescription('Export scores, including the full ranking')))
    .addSubcommand(s => optId(s.setName('resolve').setDescription('Link a quiz publication after an interrupted send')).addStringOption(o => o.setName('message').setDescription('Existing message ID').setRequired(true)));
  const seasonCommand = base('season', 'Season and all-time XP rankings', false)
    .addSubcommand(s => s.setName('start').setDescription('Staff: start a new season').addStringOption(o => o.setName('name').setDescription('Season name').setRequired(true).setMaxLength(100)).addStringOption(o => o.setName('end').setDescription('End exclusive, ISO with offset').setRequired(true)))
    .addSubcommand(s => s.setName('close').setDescription('Staff: freeze the current season'))
    .addSubcommand(s => s.setName('status').setDescription('View seasons and dates'))
    .addSubcommand(s => s.setName('ranking').setDescription('View a season or the all-time XP ranking').addStringOption(o => o.setName('id').setDescription('Season ID or general; latest season by default')))
    .addSubcommand(s => optChannel(s.setName('publish').setDescription('Staff: publish or update the current season leaderboard')));
  for (const c of [embedCommand, quizCommand, seasonCommand]) {
    check(!commands.some(old => old.name === c.name), `Command /${c.name} already exists.`);
    commands.push(c);
  }

  function body(input) {
    if (input?.messages) {
      check(input.messages.length === 1, 'Export one Discohook message at a time.');
      input = input.messages[0].data;
    }
    check(input && typeof input === 'object' && !Array.isArray(input), 'Message JSON object expected.');
    const out = { content: String(input.content || ''), embeds: [], components: [] };
    check(out.content.length <= 2000, 'Content: maximum 2,000 characters.');
    check(Array.isArray(input.embeds) && input.embeds.length <= 10, 'Use an embeds array, maximum 10.');
    for (const source of input.embeds) {
      const e = {};
      for (const [key, max] of [['title',256], ['description',4096]]) if (source[key]) {
        check(typeof source[key] === 'string' && source[key].length <= max, `${key}: maximum ${max} characters.`);
        e[key] = source[key];
      }
      if (source.color !== undefined) {
        e.color = typeof source.color === 'string' ? parseInt(source.color.replace('#',''),16) : source.color;
        check(Number.isInteger(e.color) && e.color>=0 && e.color<=0xffffff, 'Invalid embed color.');
      }
      if (source.url) e.url = url(source.url);
      if (source.timestamp) { check(Number.isFinite(Date.parse(source.timestamp)), 'Invalid timestamp.'); e.timestamp = new Date(source.timestamp).toISOString(); }
      for (const key of ['image','thumbnail']) if (source[key]?.url) {
        const u = source[key].url;
        if (u.startsWith('attachment://')) {
          const name = u.slice(13); check(Boolean(get('SELECT id FROM assets WHERE name=?',name)), 'Upload this attachment using /embed image.');
          e[key] = {url:u};
        } else e[key] = {url:url(u)};
      }
      if (source.author?.name) {
        check(source.author.name.length<=256, 'Author name: maximum 256 characters.');
        e.author = {name:source.author.name};
        if (source.author.url) e.author.url=url(source.author.url);
        if (source.author.icon_url) e.author.icon_url=url(source.author.icon_url);
      }
      if (source.footer?.text) {
        check(source.footer.text.length<=2048, 'Footer: maximum 2,048 characters.');
        e.footer={text:source.footer.text};
        if (source.footer.icon_url) e.footer.icon_url=url(source.footer.icon_url);
      }
      if (source.fields) {
        check(Array.isArray(source.fields) && source.fields.length<=25, 'Maximum 25 fields per embed.');
        e.fields=source.fields.map(f=>{
          check(typeof f.name==='string' && f.name.length>0 && f.name.length<=256 && typeof f.value==='string' && f.value.length>0 && f.value.length<=1024, 'Invalid field: name 1-256, value 1-1024 characters.');
          return {name:f.name,value:f.value,inline:Boolean(f.inline)};
        });
      }
      check(e.title || e.description || e.image || e.thumbnail || e.fields?.length || e.author || e.footer, 'An embed cannot be empty.');
      new EmbedBuilder(e).toJSON(); out.embeds.push(e);
    }
    check(out.content || out.embeds.length, 'Message cannot be empty.');
    const total = out.embeds.reduce((n,e)=>n+(e.title?.length||0)+(e.description?.length||0)+(e.author?.name.length||0)+(e.footer?.text.length||0)+(e.fields||[]).reduce((a,f)=>a+f.name.length+f.value.length,0),0);
    check(total<=6000, 'All embeds combined: maximum 6,000 text characters.');
    if (input.components?.length) {
      check(input.components.length<=5, 'Maximum 5 rows of link buttons.');
      out.components=input.components.map(r=>{
        check(r.type===1 && Array.isArray(r.components) && r.components.length>0 && r.components.length<=5, 'Invalid button row.');
        return {type:1,components:r.components.map(b=>{
          check(b.type===2 && b.style===5 && typeof b.url==='string' && b.url.length>0 && b.url.length<=512 && typeof b.label==='string' && b.label.length>0 && b.label.length<=80,'Only labelled link buttons are supported.');
          return {type:2,style:5,label:b.label,url:url(b.url)};
        })};
      });
    }
    return out;
  }
  function payload(post, notify = false) {
    const data=body(JSON.parse(post.body)); const files=[]; const names=new Set();
    for (const e of data.embeds) for (const key of ['image','thumbnail']) if(e[key]?.url.startsWith('attachment://')) names.add(e[key].url.slice(13));
    check(names.size<=10, 'Maximum 10 uploaded images per message.');
    for (const name of names) { const a=get('SELECT * FROM assets WHERE name=?',name); check(a,'Missing uploaded image.'); files.push(new AttachmentBuilder(Buffer.from(a.bytes),{name})); }
    const content=[notify&&post.role?`<@&${post.role}>`:'',data.content].filter(Boolean).join('\n');
    check(content.length<=2000,'Leave room in message content for the notification.');
    return {...data,content,files,attachments:[],allowedMentions:notify&&post.role?{parse:[],roles:[post.role]}:quiet};
  }
  function post(id) { const p=get('SELECT * FROM nx_posts WHERE id=?',id); check(p,'Embed not found.'); return p; }
  function mutate(p, data) {
    check(!['sending','uncertain'].includes(p.state),'Resolve the interrupted publication before editing.');
    const checked=body(data);
    check(run('UPDATE nx_posts SET body=?,version=version+1 WHERE id=? AND version=?',JSON.stringify(checked),p.id,p.version).changes===1,'This draft changed. Reopen /embed edit.');
    return post(p.id);
  }
  function panel(p, index=0) {
    const data=JSON.parse(p.body); index=Math.max(0,Math.min(index,data.embeds.length-1));
    const key=action=>`nx:e:${action}:${p.id}:${p.version}:${index}`;
    const components=[row(button(key('text'),'Title & text'),button(key('visual'),'Color & images'),button(key('author'),'Author & footer'),button(key('fields'),'Fields'),button(key('content'),'Message & links')),
      row(button(key('add'),'Add embed',B.Success),button(key('remove'),'Remove embed',B.Danger),button(key('preview'),'Preview',B.Primary))];
    if(data.embeds.length>1) components.push(row(new StringSelectMenuBuilder().setCustomId(key('select')).setPlaceholder('Select an embed').addOptions(data.embeds.map((e,n)=>({label:`${n+1}. ${e.title||'Untitled'}`.slice(0,100),value:String(n),default:n===index})))));
    return {content:`**${p.name}** · ID: \`${p.id}\`\nState: **${p.state}**${p.due?` · <t:${Math.floor(p.due/1000)}:F>`:''}\nEditing embed ${index+1}/${data.embeds.length}.\nSave changes, then use **/embed publish** to update the same public message. Scheduled drafts use the latest saved version.`,embeds:[],components,allowedMentions:quiet};
  }
  async function target(channelId) {
    const c=await client.channels.fetch(channelId);
    check(c?.guildId===guildId && [C.GuildText,C.GuildAnnouncement].includes(c.type),'Choose a text or announcement channel on this server.');
    check(c.permissionsFor(client.user)?.has([P.ViewChannel,P.SendMessages,P.EmbedLinks,P.AttachFiles,P.ReadMessageHistory]),'Missing channel permissions: View, Send, Embed Links, Attach Files or Read History.'); return c;
  }
  async function message(c, messageId) { try { return await c.messages.fetch(messageId); } catch(e) { if(e.code===10008) return null; throw e; } }
  async function deliver(p) {
    const data=payload(p,!p.message); const c=await target(p.channel);
    check(!['sending','uncertain','missing'].includes(p.state),'Publication needs checking. Use /embed resolve for an existing message, or /embed copy for a new draft.');
    if(p.message) {
      const m=await message(c,p.message);
      if(!m) { run("UPDATE nx_posts SET state='missing',due=NULL,note='Public message deleted; not recreated.' WHERE id=?",p.id); throw Error('Message deleted. It will not be recreated automatically.'); }
      check(m.author.id===client.user.id,'This bot does not own the message.');
      await m.edit({...payload(p,false),allowedMentions:quiet});
      run("UPDATE nx_posts SET state='published',due=NULL,sent=?,note=NULL WHERE id=?",Date.now(),p.id); return;
    }
    check(run("UPDATE nx_posts SET state='sending',attempt=? WHERE id=? AND version=? AND state IN ('draft','scheduled','failed') AND message IS NULL",id(),p.id,p.version).changes===1,'Publication already in progress or draft changed.');
    try {
      const nonce=BigInt('0x'+createHash('sha256').update(p.id).digest('hex').slice(0,16)).toString();
      const sent=await c.send({...data,nonce,enforceNonce:true});
      run("UPDATE nx_posts SET state='published',message=?,sent=?,due=NULL,note=NULL WHERE id=?",sent.id,Date.now(),p.id);
    } catch(e) {
      const definite=e.status>=400 && e.status<500 && e.status!==429;
      run('UPDATE nx_posts SET state=?,note=? WHERE id=?',definite?'failed':'uncertain',definite?'Discord rejected the message. Correct the draft and publish again.':'Delivery uncertain. Check the channel before using /embed resolve.',p.id); throw e;
    }
  }
  async function jsonFile(a) {
    check(a && a.size<=512000,'JSON file: maximum 500 KB.');
    const u=new URL(a.url); check(['cdn.discordapp.com','media.discordapp.net'].includes(u.hostname)&&u.protocol==='https:','Attach the JSON directly to the command.');
    const r=await fetch(u,{redirect:'error',signal:AbortSignal.timeout(15000)}); check(r.ok,'Cannot read attachment.');
    const chunks=[]; let size=0; for await(const c of r.body){size+=c.length;check(size<=512000,'JSON file too large.');chunks.push(c);}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/,''));}catch{throw Error('Invalid JSON. Upload JSON, not a JavaScript questions.js file.');}
  }
  async function embedSlash(i) {
    const action=i.options.getSubcommand();
    if(action==='list') {
      const entries=all('SELECT id,name,state,due,note FROM nx_posts ORDER BY rowid DESC');
      const text=entries.map(p=>`${p.id} | ${p.name} | ${p.state}${p.due?' | '+new Date(p.due).toISOString():''}${p.note?' | '+p.note:''}`).join('\n');
      return i.editReply({content:`${entries.length} messages saved. Use /embed edit with an ID.`,files:[new AttachmentBuilder(Buffer.from(text||'No messages.'),{name:'embeds.txt'})]});
    }
    if(action==='create'||action==='import') {
      const data=action==='import'?body(await jsonFile(i.options.getAttachment('file'))):{content:'',embeds:[{title:'Your title',description:'Your announcement text.',color}],components:[]};
      const key=id(); run('INSERT INTO nx_posts(id,name,body) VALUES (?,?,?)',key,i.options.getString('name'),JSON.stringify(data)); return i.editReply(panel(post(key)));
    }
    const p=post(i.options.getString('id'));
    if(action==='edit') return i.editReply(panel(p));
    if(action==='export') return i.editReply({files:[new AttachmentBuilder(Buffer.from(JSON.stringify(JSON.parse(p.body),null,2)),{name:`embed-${p.id}.json`})]});
    if(action==='copy') {const key=id();run('INSERT INTO nx_posts(id,name,body) VALUES (?,?,?)',key,p.name+' copy',p.body);return i.editReply(panel(post(key)));}
    if(action==='image') {
      check(!['sending','uncertain'].includes(p.state),'Resolve the publication first.');
      const data=JSON.parse(p.body), index=(i.options.getInteger('number')||1)-1; check(data.embeds[index],'Embed number not found.');
      const assetId=await importAsset(i.options.getAttachment('file')); const a=get('SELECT name FROM assets WHERE id=?',assetId);
      data.embeds[index][i.options.getBoolean('thumbnail')?'thumbnail':'image']={url:`attachment://${a.name}`};
      return i.editReply(panel(mutate(p,data),index));
    }
    if(action==='resolve') {
      check(['uncertain','missing'].includes(p.state),'Only uncertain or missing publications need resolving.');
      const c=await target(p.channel); const m=await message(c,i.options.getString('message'));
      check(m?.author.id===client.user.id,'Existing message must belong to this bot.');
      run("UPDATE nx_posts SET state='published',message=?,due=NULL,note=NULL,version=version+1 WHERE id=?",m.id,p.id);return i.editReply('Linked. Use /embed publish to update this message.');
    }
    if(action==='cancel') {
      check(p.state==='scheduled','This message is not scheduled.');
      check(run("UPDATE nx_posts SET state='draft',due=NULL,version=version+1 WHERE id=? AND state='scheduled' AND version=?",p.id,p.version).changes===1,'The message changed or is already being sent.');
      return i.editReply('Schedule cancelled. The draft is preserved.');
    }
    const c=await target(i.options.getChannel('channel').id);
    check(!p.message||p.channel===c.id,'A published message stays in its original channel. Use /embed copy to publish elsewhere.');
    check(!['sending','uncertain','missing'].includes(p.state),'Resolve this publication first, or duplicate it with /embed copy.');
    if(action==='schedule') {
      check(!p.message,'Only unpublished drafts can be scheduled.'); const due=iso(i.options.getString('at'));check(due>Date.now()+10000,'Choose a future publication time.');
      payload({...p,role:i.options.getRole('notify')?.id||null},true);
      check(run("UPDATE nx_posts SET state='scheduled',channel=?,role=?,due=?,version=version+1 WHERE id=? AND version=? AND state IN ('draft','scheduled','failed')",c.id,i.options.getRole('notify')?.id||null,due,p.id,p.version).changes===1,'Draft changed. Reopen it.');
      payload(post(p.id),true); return i.editReply(`Scheduled for <t:${Math.floor(due/1000)}:F> in <#${c.id}>. ID: \`${p.id}\``);
    }
    check(run('UPDATE nx_posts SET channel=?,role=?,version=version+1 WHERE id=? AND version=? AND state NOT IN (\'sending\',\'uncertain\',\'missing\')',c.id,p.message?p.role:i.options.getRole('notify')?.id||null,p.id,p.version).changes===1,'Draft changed. Reopen it.');
    await deliver(post(p.id));return i.editReply('Saved to Discord. Existing published messages are edited in place.');
  }

  async function editor(i, fields) {
    const [, , action, key, ver, selected]=fields; const p=post(key);admin(i);
    check(p.version===Number(ver),'This editor is outdated. Reopen /embed edit.');
    const index=Number(selected)||0, data=JSON.parse(p.body), e=data.embeds[index]||{};
    const modalKey=type=>`nx:f:${type}:${key}:${ver}:${index}`;
    if(i.isButton() && ['text','visual','author','fields','content'].includes(action)) {
      let inputs;
      if(action==='text') inputs=[['title','Title',T.Short,e.title,false,256],['description','Description',T.Paragraph,e.description,false,4000],['url','Title link (HTTPS)',T.Short,e.url,false,1000]];
      if(action==='visual') inputs=[['color','Color (#5865F2)',T.Short,'#'+(e.color??color).toString(16).padStart(6,'0'),false,7],['image','Large image URL; empty to remove',T.Short,e.image?.url,false,1000],['thumbnail','Thumbnail URL; empty to remove',T.Short,e.thumbnail?.url,false,1000]];
      if(action==='author') inputs=[['name','Author name',T.Short,e.author?.name,false,256],['authorurl','Author link',T.Short,e.author?.url,false,1000],['authoricon','Author icon URL',T.Short,e.author?.icon_url,false,1000],['footer','Footer text',T.Paragraph,e.footer?.text,false,2048],['footericon','Footer icon URL',T.Short,e.footer?.icon_url,false,1000]];
      if(action==='fields') inputs=[['fields','Fields JSON array: name, value, inline',T.Paragraph,JSON.stringify(e.fields||[],null,2),true,4000]];
      if(action==='content') inputs=[['content','Text outside embeds',T.Paragraph,data.content,false,2000],['links','Link buttons JSON: label and url',T.Paragraph,JSON.stringify(data.components.flatMap(r=>r.components.map(b=>({label:b.label,url:b.url}))),null,2),true,4000]];
      return i.showModal(form(modalKey(action),'Edit announcement',inputs));
    }
    await i.deferUpdate();
    if(action==='select') return i.editReply(panel(p,Number(i.values[0])));
    if(action==='preview') { await i.followUp({...payload(p,false),flags:F.Ephemeral}); return; }
    if(action==='add') {check(data.embeds.length<10,'Maximum 10 embeds per message.');data.embeds.push({title:'New embed',description:'Your text.',color});return i.editReply(panel(mutate(p,data),data.embeds.length-1));}
    if(action==='remove') {check(data.embeds.length>1,'Keep at least one embed in this editor.');data.embeds.splice(index,1);return i.editReply(panel(mutate(p,data),Math.max(0,index-1)));}
    if(i.isModalSubmit()) {
      if(action==='text') {for(const k of ['title','description','url']){const v=value(i,k);if(v)e[k]=v;else delete e[k];}}
      if(action==='visual') {
        const c=value(i,'color');check(!c||/^#[a-f\d]{6}$/i.test(c),'Color must be #RRGGBB.');if(c)e.color=parseInt(c.slice(1),16);else delete e.color;
        for(const k of ['image','thumbnail']){const v=value(i,k);if(v)e[k]={url:v};else delete e[k];}
      }
      if(action==='author') {
        const name=value(i,'name'), footer=value(i,'footer');delete e.author;delete e.footer;
        if(name)e.author={name,...(value(i,'authorurl')?{url:value(i,'authorurl')}:{}),...(value(i,'authoricon')?{icon_url:value(i,'authoricon')}:{})};
        if(footer)e.footer={text:footer,...(value(i,'footericon')?{icon_url:value(i,'footericon')}:{})};
      }
      if(action==='fields') {try{e.fields=JSON.parse(value(i,'fields'));}catch{throw Error('Fields must be a JSON array.');}}
      if(action==='content') {
        data.content=value(i,'content');let links;try{links=JSON.parse(value(i,'links'));}catch{throw Error('Link buttons must be a JSON array.');}
        check(Array.isArray(links)&&links.length<=25,'Maximum 25 link buttons.');data.components=[];
        for(let n=0;n<links.length;n+=5)data.components.push({type:1,components:links.slice(n,n+5).map(l=>({type:2,style:5,label:l.label,url:l.url}))});
      }
      if(data.embeds[index])data.embeds[index]=e;
      return i.editReply(panel(mutate(p,data),index));
    }
  }

  function latestSeason(){return get('SELECT * FROM nx_seasons ORDER BY start DESC LIMIT 1');}
  function ranking(key, member) {
    if(key==='general') {
      const entries=all('SELECT id AS user,xp FROM users WHERE xp>0 ORDER BY xp DESC,id LIMIT 20'); const me=get('SELECT xp FROM users WHERE id=?',member)?.xp||0;
      return {name:'All-time XP',entries,xp:me,rank:me?get('SELECT COUNT(*)+1 AS n FROM users WHERE xp>? OR (xp=? AND id<?)',me,me,member).n:null};
    }
    const season=get('SELECT * FROM nx_seasons WHERE id=?',key);check(season,'Season not found.');
    const entries=all('SELECT user,xp FROM nx_season_points WHERE season=? AND xp>0 ORDER BY xp DESC,user LIMIT 20',key);const me=get('SELECT xp FROM nx_season_points WHERE season=? AND user=?',key,member)?.xp||0;
    return {name:season.name,entries,xp:me,rank:me?get('SELECT COUNT(*)+1 AS n FROM nx_season_points WHERE season=? AND (xp>? OR (xp=? AND user<?))',key,me,me,member).n:null};
  }
  function board(key) {
    const r=ranking(key,'0');return {embeds:[new EmbedBuilder().setColor(color).setTitle(`🏆 ${r.name}`).setDescription(r.entries.map((u,n)=>`**${n+1}.** <@${u.user}> · **${u.xp.toLocaleString('en-US')} XP**`).join('\n')||'No XP yet.').setFooter({text:'Top 20 · Equal scores are ordered by Discord ID.'}).setTimestamp()],components:[row(button(`nx:r:${key}`,'View my rank'))],allowedMentions:quiet};
  }
  async function seasonSlash(i) {
    const action=i.options.getSubcommand();
    if(['start','close','publish'].includes(action))admin(i);
    if(action==='status') {const seasons=all('SELECT * FROM nx_seasons ORDER BY start DESC LIMIT 15');return i.editReply(seasons.map(s=>`**${s.name}** · \`${s.id}\`\n<t:${Math.floor(s.start/1000)}:F> → <t:${Math.floor(s.end/1000)}:F> · ${s.closed||s.end<=Date.now()?'Finished':'Active'}`).join('\n\n')||'No season yet. All-time XP is preserved.');}
    if(action==='start') {
      const end=iso(i.options.getString('end'));check(end>Date.now(),'Season end must be in the future.');
      const key=id();transaction(()=>{check(!get('SELECT id FROM nx_seasons WHERE closed=0 AND end>?',Date.now()),'Close the current season first.');run('INSERT INTO nx_seasons(id,name,start,end) VALUES (?,?,?,?)',key,i.options.getString('name'),Date.now(),end);});
      return i.editReply(`Season started: \`${key}\`. Season XP starts at zero; all-time XP is preserved. Rewards earned from now until the end count in both.`);
    }
    const s=latestSeason();
    if(action==='ranking')return i.editReply(board(i.options.getString('id')||s?.id||'general'));
    check(s,'Start a season first.');
    if(action==='close'){check(!s.closed,'Season already closed.');run('UPDATE nx_seasons SET closed=1 WHERE id=?',s.id);return i.editReply('Season frozen. All-time XP keeps increasing. A new season starts with its own zero score.');}
    const c=await target(i.options.getChannel('channel').id);check(!s.board_channel||s.board_channel===c.id,'Use the existing season leaderboard channel.');
    if(s.board_message){const m=await message(c,s.board_message);check(m,'Leaderboard was deleted; it will not be recreated automatically.');await m.edit(board(s.id));}
    else{const m=await c.send(board(s.id));run('UPDATE nx_seasons SET board_channel=?,board_message=? WHERE id=?',c.id,m.id,s.id);}
    return i.editReply('Season leaderboard published. Refreshes every minute while the bot is online.');
  }

  function questions(input) {
    const list=Array.isArray(input)?input:input?.questions;check(Array.isArray(list)&&list.length>=1&&list.length<=50,'Use 1 to 50 questions.');
    return list.map(q=>{check(typeof q.question==='string'&&q.question.length>0&&q.question.length<=1000&&Array.isArray(q.choices)&&q.choices.length>=2&&q.choices.length<=4&&q.choices.every(c=>typeof c==='string'&&c.length>0&&c.length<=150),'Each question needs text and 2-4 choices (maximum 150 characters each).');check(Number.isInteger(q.answer)&&q.answer>=0&&q.answer<q.choices.length,'answer must be a zero-based index: 0, 1, 2 or 3.');return{question:q.question,choices:q.choices,answer:q.answer,explanation:String(q.explanation||'').slice(0,1000)};});
  }
  function quiz(key){const q=get('SELECT * FROM nx_quizzes WHERE id=?',key);check(q,'Quiz not found.');return q;}
  function quizCard(q){return {embeds:[new EmbedBuilder().setColor(color).setTitle(`🧠 ${q.title}`).setDescription(`${JSON.parse(q.questions).length} questions · ${q.seconds} seconds per question.\n\nCorrect and faster answers earn more quiz points.\nComplete the quiz to earn **${q.reward} XP**, once.\n\nOne attempt per member. Your answers are private.`)],components:[row(button(`nx:q:start:${q.id}`,q.state==='closed'?'Quiz closed':'Start quiz',B.Primary).setDisabled(q.state==='closed'))],allowedMentions:quiet};}
  function questionCard(q,a,note='') {
    if(a.done)return{content:`${note}\n🏁 **Quiz complete!**\n**${a.score} quiz points** · **${a.correct}/${JSON.parse(q.questions).length} correct**\n**${q.reward} XP** added once to your all-time score and to any active season.`,embeds:[],components:[],allowedMentions:quiet};
    const list=JSON.parse(q.questions), question=list[a.step];
    return{content:note||'',embeds:[new EmbedBuilder().setColor(color).setTitle(`Question ${a.step+1}/${list.length}`).setDescription(`**${question.question}**\n\n${question.choices.map((c,n)=>`**${'ABCD'[n]}.** ${c}`).join('\n\n')}`).setFooter({text:`${q.seconds}s to answer. After the deadline, click any answer to move on with 0 points.`})],components:[row(...question.choices.map((c,n)=>button(`nx:q:answer:${q.id}:${a.step}:${n}`,'ABCD'[n],B.Primary)))],allowedMentions:quiet};
  }
  async function quizSlash(i) {
    const action=i.options.getSubcommand();
    if(action==='list')return i.editReply(all('SELECT id,title,state FROM nx_quizzes ORDER BY rowid DESC LIMIT 30').map(q=>`\`${q.id}\` · ${q.title} · ${q.state}`).join('\n')||'No quiz.');
    if(action==='create'){const list=questions(await jsonFile(i.options.getAttachment('file')));const key=id();run('INSERT INTO nx_quizzes(id,title,questions,seconds,reward) VALUES (?,?,?,?,?)',key,i.options.getString('title'),JSON.stringify(list),i.options.getInteger('seconds')||15,i.options.getInteger('xp')??75);return i.editReply(`Quiz created: \`${key}\`. Use /quiz publish.`);}
    const q=quiz(i.options.getString('id'));
    if(action==='results') {
      const list=all('SELECT user,score,correct,done FROM nx_attempts WHERE quiz=? ORDER BY done DESC,score DESC,started,user',q.id);
      const text=['rank;discord_id;quiz_points;correct;completed',...list.map((a,n)=>`${n+1};"${a.user}";${a.score};${a.correct};${a.done?'yes':'no'}`)].join('\r\n');
      return i.editReply({content:'Completed attempts appear first. Quiz points determine this quiz ranking; the participation XP reward is separate.',files:[new AttachmentBuilder(Buffer.from('\uFEFF'+text),{name:'quiz-results.csv'})]});
    }
    if(action==='resolve'){check(q.state==='uncertain','This quiz does not need resolving.');const c=await target(q.channel);const m=await message(c,i.options.getString('message'));check(m?.author.id===client.user.id,'Existing message must belong to this bot.');run("UPDATE nx_quizzes SET message=?,state='open' WHERE id=?",m.id,q.id);await m.edit(quizCard(quiz(q.id)));return i.editReply('Quiz publication linked.');}
    if(action==='close'){run("UPDATE nx_quizzes SET state='closed' WHERE id=?",q.id);if(q.message){const c=await target(q.channel);const m=await message(c,q.message);if(m)await m.edit(quizCard(quiz(q.id)));}return i.editReply('Quiz closed. Incomplete attempts earn no XP.');}
    const c=await target(i.options.getChannel('channel').id);check(q.state==='draft','This quiz was already published or needs checking.');
    check(run("UPDATE nx_quizzes SET state='sending',channel=? WHERE id=? AND state='draft'",c.id,q.id).changes===1,'Publication already started.');
    try{const m=await c.send(quizCard({...q,state:'open'}));run("UPDATE nx_quizzes SET state='open',message=? WHERE id=?",m.id,q.id);}catch(e){run("UPDATE nx_quizzes SET state='uncertain' WHERE id=?",q.id);throw e;}
    return i.editReply('Quiz published.');
  }
  async function play(i, fields) {
    const action=fields[2],key=fields[3];const q=quiz(key);check(q.state==='open','This quiz is closed or unavailable.');
    if(action==='start') {
      await i.deferReply({flags:F.Ephemeral});
      let a=get('SELECT * FROM nx_attempts WHERE quiz=? AND user=?',key,i.user.id);
      if(!a){run('INSERT OR IGNORE INTO nx_attempts(quiz,user,deadline,started) VALUES (?,?,?,?)',key,i.user.id,Date.now()+q.seconds*1000,Date.now());a=get('SELECT * FROM nx_attempts WHERE quiz=? AND user=?',key,i.user.id);}
      return i.editReply(questionCard(q,a,a.done?'Already completed. Your XP was not awarded again.':''));
    }
    await i.deferUpdate();let note='';
    transaction(()=>{
      const a=get('SELECT * FROM nx_attempts WHERE quiz=? AND user=?',key,i.user.id);check(a&&!a.done,'Attempt already completed or not started.');
      check(a.step===Number(fields[4]),'This question was already answered. Click Start quiz to resume.');
      const list=JSON.parse(q.questions), current=list[a.step], choice=Number(fields[5]);check(Number.isInteger(choice)&&choice>=0&&choice<current.choices.length,'Invalid answer.');
      const onTime=Date.now()<=a.deadline,correct=onTime&&choice===current.answer;
      const points=correct?20+Math.floor(80*Math.max(0,Math.min(1,(a.deadline-Date.now())/(q.seconds*1000)))):0;
      note=`${correct?'✅ Correct':onTime?'❌ Incorrect':'⏱️ Time expired'} · **+${points} quiz points**\n${current.explanation}`;
      const done=a.step+1===list.length;
      run('UPDATE nx_attempts SET step=step+1,score=score+?,correct=correct+?,deadline=?,done=? WHERE quiz=? AND user=?',points,correct?1:0,Date.now()+q.seconds*1000,done?1:0,key,i.user.id);
      if(done&&q.reward)add(i.user.id,q.reward,0);
    });
    return i.editReply(questionCard(q,get('SELECT * FROM nx_attempts WHERE quiz=? AND user=?',key,i.user.id),note));
  }

  let ticking=false,lastBoard=0;
  async function tick() {
    if(ticking||!isReady())return;ticking=true;
    try {
      for(const p of all("SELECT * FROM nx_posts WHERE state='scheduled' AND due<=? ORDER BY due LIMIT 10",Date.now())) {
        try{await deliver(p);}catch(e){run("UPDATE nx_posts SET state='failed',note=? WHERE id=? AND state='scheduled'",String(e.message).slice(0,300),p.id);console.error('Scheduled announcement:',e.code||e.name);}
      }
      if(Date.now()-lastBoard>60000){lastBoard=Date.now();for(const s of all('SELECT * FROM nx_seasons WHERE board_message IS NOT NULL')){
        try{const c=await target(s.board_channel);const m=await message(c,s.board_message);if(m)await m.edit(board(s.id));}catch(e){console.error('Season board:',e.code||e.name);}
      }}
    }finally{ticking=false;}
  }
  function handles(i) {
    return i.guildId===guildId && (i.isChatInputCommand()?['embed','quiz','season'].includes(i.commandName):Boolean(i.customId?.startsWith('nx:')));
  }
  async function handle(i) {
    try {
      check(isReady(),'Bot starting. Try again in a moment.');
      if(i.isChatInputCommand()) {
        if(i.commandName!=='season')admin(i);
        await i.deferReply({flags:F.Ephemeral});
        if(i.commandName==='embed')return await embedSlash(i);
        if(i.commandName==='quiz')return await quizSlash(i);
        return await seasonSlash(i);
      }
      const fields=i.customId.split(':');
      if(['e','f'].includes(fields[1]))return await editor(i,fields);
      if(fields[1]==='q')return await play(i,fields);
      if(fields[1]==='r'){await i.deferReply({flags:F.Ephemeral});const r=ranking(fields[2],i.user.id);return i.editReply(`**${r.name}**\n${r.rank?`Rank **#${r.rank}** · **${r.xp.toLocaleString('en-US')} XP**`:'No XP on this leaderboard yet.'}`);}
    } catch(e) {
      const content=String(e.message||'Action failed.').replaceAll(process.env.DISCORD_TOKEN||'__no_token__','[TOKEN HIDDEN]').slice(0,1800);
      try{if(i.deferred||i.replied)await i.followUp({content,flags:F.Ephemeral,allowedMentions:quiet});else await i.reply({content,flags:F.Ephemeral,allowedMentions:quiet});}catch{console.error('Netcord extension response failed.');}
    }
  }
  return {
    handles, handle, tick, body, questions, ranking, jsonFile,
    messagePayload: message => payload({ body: JSON.stringify(message) }),
    embedPayload: id => payload(post(id)),
  };
};
