"use strict";

const {
  Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, REST, Routes, MessageFlags,
} = require("discord.js");
const { Player, QueueRepeatMode, useQueue } = require("discord-player");
const { DefaultExtractors } = require("@discord-player/extractor");
const { YoutubeiExtractor } = require("discord-player-youtubei");

const TOKEN = (process.env.TOKEN || "").trim();
const CLIENT_ID = (process.env.CLIENT_ID || "").trim();
const GUILD_ID = (process.env.GUILD_ID || "").trim();
const AFK_CHANNEL_ID = (process.env.AFK_CHANNEL_ID || "").trim(); // voice channel untuk mode AFK 24/7 (butuh GUILD_ID)
const DEFAULT_VOLUME = Math.min(100, Math.max(1, Number.parseInt(process.env.DEFAULT_VOLUME || "50", 10) || 50));

if (!TOKEN || !CLIENT_ID) {
  console.error("[BOOT] TOKEN dan CLIENT_ID wajib diisi.");
  process.exit(1);
}

// Bot musik cukup 2 intent; tidak butuh Message Content.
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  allowedMentions: { parse: [], repliedUser: false },
});

const player = new Player(client);

// Bot tidak pernah keluar VC sendiri (antrian habis / VC kosong / stop) supaya bisa jadi AFK 24/7.
function nodeOptions(channel) {
  return {
    metadata: { channel },
    volume: DEFAULT_VOLUME,
    selfDeaf: true,
    leaveOnEmpty: false,
    leaveOnEnd: false,
    leaveOnStop: false,
  };
}

// ---------------- Slash commands ----------------
const commands = [
  new SlashCommandBuilder().setName("play").setDescription("Putar lagu (judul atau link YouTube/Spotify)")
    .addStringOption((o) => o.setName("query").setDescription("Judul atau link").setRequired(true)),
  new SlashCommandBuilder().setName("pause").setDescription("Jeda lagu"),
  new SlashCommandBuilder().setName("resume").setDescription("Lanjutkan lagu"),
  new SlashCommandBuilder().setName("skip").setDescription("Lewati lagu sekarang"),
  new SlashCommandBuilder().setName("stop").setDescription("Berhenti & kosongkan antrian (bot tetap di VC)"),
  new SlashCommandBuilder().setName("queue").setDescription("Lihat antrian"),
  new SlashCommandBuilder().setName("nowplaying").setDescription("Lagu yang sedang diputar"),
  new SlashCommandBuilder().setName("volume").setDescription("Atur volume")
    .addIntegerOption((o) => o.setName("persen").setDescription("1-100").setRequired(true).setMinValue(1).setMaxValue(100)),
  new SlashCommandBuilder().setName("loop").setDescription("Atur loop")
    .addStringOption((o) => o.setName("mode").setDescription("Mode loop").setRequired(true)
      .addChoices({ name: "Mati", value: "off" }, { name: "Lagu ini", value: "track" }, { name: "Seluruh antrian", value: "queue" })),
  new SlashCommandBuilder().setName("shuffle").setDescription("Acak antrian"),
  new SlashCommandBuilder().setName("remove").setDescription("Hapus lagu dari antrian")
    .addIntegerOption((o) => o.setName("nomor").setDescription("Nomor di /queue").setRequired(true).setMinValue(1)),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  const route = GUILD_ID ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID) : Routes.applicationCommands(CLIENT_ID);
  await rest.put(route, { body: commands });
  console.log(`[DISCORD] Slash commands terdaftar (${GUILD_ID ? "server" : "global"}).`);
}

// ---------------- Helpers ----------------
const EPH = MessageFlags.Ephemeral;
const fmtTrack = (t) => `**${t.title}** — ${t.author} \`${t.duration}\``;

// Return queue kalau user boleh mengontrol, atau null (dan sudah membalas).
async function requireQueue(i) {
  const queue = useQueue(i.guild.id);
  if (!queue || !queue.isPlaying()) {
    await i.reply({ content: "nggak ada lagu yang lagi diputar.", flags: EPH });
    return null;
  }
  if (i.member.voice?.channelId !== queue.channel.id) {
    await i.reply({ content: "masuk dulu ke voice channel yang sama dengan bot.", flags: EPH });
    return null;
  }
  return queue;
}

const handlers = {
  async play(i) {
    const vc = i.member.voice?.channel;
    if (!vc) return i.reply({ content: "masuk voice channel dulu.", flags: EPH });

    const me = i.guild.members.me;
    const perms = vc.permissionsFor(me);
    if (!perms || !perms.has(["Connect", "Speak"])) {
      return i.reply({ content: "bot nggak punya izin Connect/Speak di voice channel itu.", flags: EPH });
    }
    const existing = useQueue(i.guild.id);
    if (existing && existing.channel.id !== vc.id) {
      return i.reply({ content: "bot lagi dipakai di voice channel lain.", flags: EPH });
    }

    await i.deferReply();
    try {
      // Queue AFK yang sudah standby: arahkan notifikasi ke channel tempat /play dipakai.
      if (existing) existing.setMetadata({ channel: i.channel });
      const { track, searchResult } = await player.play(vc, i.options.getString("query", true), {
        requestedBy: i.user,
        nodeOptions: nodeOptions(i.channel),
      });
      const extra = searchResult?.playlist ? ` (playlist: ${searchResult.playlist.tracks.length} lagu)` : "";
      await i.editReply(`🎶 ditambahkan: ${fmtTrack(track)}${extra}`);
    } catch (error) {
      console.error("[PLAY]", error);
      await i.editReply("❌ nggak nemu lagunya atau gagal diputar. coba judul lain / link lain.");
    }
  },

  async pause(i) {
    const q = await requireQueue(i); if (!q) return;
    q.node.pause();
    await i.reply("⏸️ dijeda.");
  },
  async resume(i) {
    const q = await requireQueue(i); if (!q) return;
    q.node.resume();
    await i.reply("▶️ lanjut.");
  },
  async skip(i) {
    const q = await requireQueue(i); if (!q) return;
    const current = q.currentTrack;
    q.node.skip();
    await i.reply(`⏭️ dilewati: **${current?.title ?? "lagu"}**`);
  },
  async stop(i) {
    const q = await requireQueue(i); if (!q) return;
    q.tracks.clear();
    q.node.stop(); // berhenti & kosongkan antrian, tapi tetap di VC
    await i.reply("⏹️ berhenti. bot tetap standby di VC.");
  },
  async queue(i) {
    const q = useQueue(i.guild.id);
    if (!q || !q.currentTrack) return i.reply({ content: "antrian kosong.", flags: EPH });
    const upcoming = q.tracks.toArray();
    const lines = upcoming.slice(0, 10).map((t, idx) => `${idx + 1}. ${fmtTrack(t)}`);
    const more = upcoming.length > 10 ? `\n…dan ${upcoming.length - 10} lagu lagi` : "";
    const embed = new EmbedBuilder()
      .setTitle("Antrian")
      .setDescription(`**Sekarang:** ${fmtTrack(q.currentTrack)}\n\n${lines.join("\n") || "_(tidak ada lagu berikutnya)_"}${more}`);
    await i.reply({ embeds: [embed] });
  },
  async nowplaying(i) {
    const q = useQueue(i.guild.id);
    if (!q || !q.currentTrack) return i.reply({ content: "nggak ada lagu yang lagi diputar.", flags: EPH });
    const t = q.currentTrack;
    const embed = new EmbedBuilder()
      .setTitle("Sedang diputar")
      .setDescription(`${fmtTrack(t)}\n\n${q.node.createProgressBar() || ""}`)
      .setThumbnail(t.thumbnail || null)
      .setURL(t.url);
    await i.reply({ embeds: [embed] });
  },
  async volume(i) {
    const q = await requireQueue(i); if (!q) return;
    const v = i.options.getInteger("persen", true);
    q.node.setVolume(v);
    await i.reply(`🔊 volume ${v}%`);
  },
  async loop(i) {
    const q = await requireQueue(i); if (!q) return;
    const mode = i.options.getString("mode", true);
    const map = { off: QueueRepeatMode.OFF, track: QueueRepeatMode.TRACK, queue: QueueRepeatMode.QUEUE };
    q.setRepeatMode(map[mode]);
    await i.reply(`🔁 loop: **${mode}**`);
  },
  async shuffle(i) {
    const q = await requireQueue(i); if (!q) return;
    if (q.tracks.size < 2) return i.reply({ content: "lagu di antrian kurang dari 2.", flags: EPH });
    q.tracks.shuffle();
    await i.reply("🔀 antrian diacak.");
  },
  async remove(i) {
    const q = await requireQueue(i); if (!q) return;
    const n = i.options.getInteger("nomor", true);
    const target = q.tracks.toArray()[n - 1];
    if (!target) return i.reply({ content: "nomor itu nggak ada di antrian.", flags: EPH });
    q.removeTrack(n - 1);
    await i.reply(`🗑️ dihapus: **${target.title}**`);
  },
};

client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand() || !i.guild) return;
  try {
    await handlers[i.commandName]?.(i);
  } catch (error) {
    console.error("[CMD]", i.commandName, error);
    const payload = { content: "💀 error. coba lagi.", flags: EPH };
    try { i.deferred || i.replied ? await i.followUp(payload) : await i.reply(payload); } catch {}
  }
});

// ---------------- Player events ----------------
player.events.on("playerStart", (queue, track) => {
  queue.metadata?.channel?.send(`▶️ sekarang: ${fmtTrack(track)}`).catch(() => {});
});
player.events.on("emptyQueue", (queue) => {
  queue.metadata?.channel?.send("antrian habis.").catch(() => {});
});
player.events.on("playerError", (queue, error, track) => {
  console.error("[PLAYER] playerError:", error?.message || error);
  queue.metadata?.channel?.send(`⚠️ gagal memutar **${track?.title ?? "lagu"}**, lanjut ke berikutnya.`).catch(() => {});
});
player.events.on("error", (queue, error) => {
  console.error("[PLAYER] error:", error?.message || error);
});

// ---------------- AFK 24/7 ----------------
let afkJoining = false;
async function ensureAfk() {
  if (!AFK_CHANNEL_ID || !GUILD_ID || afkJoining) return;
  afkJoining = true;
  try {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) throw new Error(`guild tidak ditemukan: ${GUILD_ID}`);
    const channel = guild.channels.cache.get(AFK_CHANNEL_ID) || (await guild.channels.fetch(AFK_CHANNEL_ID).catch(() => null));
    if (!channel || !channel.isVoiceBased()) throw new Error("AFK_CHANNEL_ID bukan voice channel / tidak ditemukan");

    const existing = useQueue(guild.id);
    if (existing && existing.dispatcher) return; // sudah terhubung (sedang main atau standby)

    const queue = player.nodes.create(guild, nodeOptions(null));
    await queue.connect(channel);
    console.log(`[AFK] Standby di VC: ${channel.name}`);
  } catch (error) {
    console.error("[AFK] Gagal masuk VC:", error?.message || error);
  } finally {
    afkJoining = false;
  }
}

// ---------------- Boot ----------------
client.once("ready", async () => {
  try {
    await player.extractors.loadMulti(DefaultExtractors);
    await player.extractors.register(YoutubeiExtractor, {});
    console.log("[PLAYER] Extractor dimuat.");
    await registerCommands();
    await ensureAfk();
    setInterval(ensureAfk, 60 * 1000); // watchdog: masuk lagi kalau terputus / ditendang
    console.log(`[DISCORD] Online sebagai ${client.user.tag}`);
  } catch (error) {
    console.error("[BOOT] Gagal inisialisasi:", error);
  }
});


process.on("unhandledRejection", (e) => console.error("[ERROR] Unhandled rejection:", e));
process.on("uncaughtException", (e) => console.error("[ERROR] Uncaught exception:", e));

client.login(TOKEN).catch((error) => {
  console.error("[DISCORD] Login gagal:", error.message);
  process.exit(1);
});
