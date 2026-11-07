
"use strict";

const {
  Client,
  GatewayIntentBits,
  Events,
  PermissionFlagsBits,
} = require("discord.js");

const {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  EndBehaviorType,
} = require("@discordjs/voice");

const { OpusEncoder } = require("@discordjs/opus");

const TOKEN = (process.env.DISCORD_TOKEN || "").trim();
const GUILD_ID = (process.env.TEST_GUILD_ID || "").trim();
const CHANNEL_ID = (process.env.TEST_VOICE_CHANNEL_ID || "").trim();

const TIMEOUT_MS = Number(
  process.env.RECEIVER_TEST_TIMEOUT_MS || 90_000
);

const MAX_CAPTURE_SECONDS_PER_USER = 8;
const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;

const MAX_PCM_BYTES_PER_USER =
  SAMPLE_RATE *
  CHANNELS *
  BYTES_PER_SAMPLE *
  MAX_CAPTURE_SECONDS_PER_USER;

const VALID_FRAME_SAMPLES = new Set([
  120, 240, 480, 960, 1920, 2880,
]);

function log(level, message) {
  console.log(
    `${new Date().toISOString()} [${level}] ${message}`
  );
}

function validSnowflake(value) {
  return /^\d{17,20}$/.test(value);
}

function summarizeError(error) {
  if (!error) return "unknown error";
  return error.stack || error.message || String(error);
}

if (
  !TOKEN ||
  !validSnowflake(GUILD_ID) ||
  !validSnowflake(CHANNEL_ID)
) {
  log(
    "FAIL",
    "Environment tidak lengkap: butuh DISCORD_TOKEN, TEST_GUILD_ID, dan TEST_VOICE_CHANNEL_ID."
  );
  process.exit(1);
}

if (
  !Number.isInteger(TIMEOUT_MS) ||
  TIMEOUT_MS < 15_000 ||
  TIMEOUT_MS > 300_000
) {
  log(
    "FAIL",
    "RECEIVER_TEST_TIMEOUT_MS harus integer 15000-300000 ms."
  );
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const subscriptions = new Map();

let connection;
let done = false;
let watchdog;
let readyTimer;

function finish(ok, message, error) {
  if (done) return;

  done = true;

  clearTimeout(watchdog);
  clearTimeout(readyTimer);

  log(ok ? "PASS" : "FAIL", message);

  if (error) {
    log("ERROR", summarizeError(error));
  }

  for (const [userId, session] of subscriptions) {
    try {
      session.stream.destroy();
    } catch {}

    log(
      "INFO",
      `Subscription dibersihkan untuk user ${userId}.`
    );
  }

  subscriptions.clear();

  try {
    connection?.destroy();
  } catch (cleanupError) {
    log(
      "ERROR",
      `Gagal destroy voice connection: ${summarizeError(cleanupError)}`
    );
  }

  try {
    client.destroy();
  } catch (cleanupError) {
    log(
      "ERROR",
      `Gagal destroy Discord client: ${summarizeError(cleanupError)}`
    );
  }

  process.exitCode = ok ? 0 : 1;
}

function failIfActive(message, error) {
  if (!done) {
    finish(false, message, error);
  }
}

function startSubscription(userId) {
  if (done || subscriptions.has(userId)) return;

  const receiver = connection.receiver;
  const decoder = new OpusEncoder(SAMPLE_RATE, CHANNELS);

  const stream = receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: 1_000,
    },
  });

  const session = {
    decoder,
    stream,
    opusPackets: 0,
    pcmBytes: 0,
    badPcmChunks: 0,
  };

  subscriptions.set(userId, session);

  log(
    "INFO",
    `Speaking start: userId=${userId}; stream Opus dibuat.`
  );

  stream.on("data", (packet) => {
    if (done) return;

    try {
      if (
        !packet ||
        !Buffer.isBuffer(packet.payload) ||
        packet.payload.length === 0
      ) {
        throw new Error(
          "Receiver memberikan packet tanpa payload Opus."
        );
      }

      session.opusPackets++;

      const pcm = decoder.decode(packet.payload);

      if (!Buffer.isBuffer(pcm) || pcm.length === 0) {
        throw new Error(
          "Decoder mengembalikan PCM kosong."
        );
      }

      const samplesPerChannel =
        pcm.length / (CHANNELS * BYTES_PER_SAMPLE);

      const validPcm =
        pcm.length % (CHANNELS * BYTES_PER_SAMPLE) === 0 &&
        VALID_FRAME_SAMPLES.has(samplesPerChannel);

      if (!validPcm) {
        session.badPcmChunks++;

        throw new Error(
          `Format PCM tidak valid: ${pcm.length} bytes, ${samplesPerChannel} sampel/channel.`
        );
      }

      session.pcmBytes += pcm.length;

      if (session.pcmBytes > MAX_PCM_BYTES_PER_USER) {
        throw new Error(
          `Batas uji terlampaui (${MAX_CAPTURE_SECONDS_PER_USER}s PCM per pengguna).`
        );
      }

      if (
        session.opusPackets === 1 ||
        session.opusPackets % 25 === 0
      ) {
        log(
          "INFO",
          `userId=${userId}: ${session.opusPackets} paket Opus, ${session.pcmBytes} bytes PCM tervalidasi (48 kHz, stereo, signed 16-bit LE).`
        );
      }
    } catch (error) {
      failIfActive(
        `Gagal menerima atau decode paket audio dari user ${userId}.`,
        error
      );
    }
  });

  stream.once("error", (error) => {
    failIfActive(
      `AudioReceiveStream error untuk user ${userId}.`,
      error
    );
  });

  stream.once("close", () => {
    if (done) return;

    subscriptions.delete(userId);

    log(
      "INFO",
      `Stream selesai: userId=${userId}; ${session.opusPackets} paket Opus; ${session.pcmBytes} bytes PCM; ${session.badPcmChunks} frame PCM invalid.`
    );

    if (
      session.opusPackets > 0 &&
      session.pcmBytes > 0 &&
      session.badPcmChunks === 0
    ) {
      finish(
        true,
        `Discord receiver menerima Opus dan decode PCM valid untuk user ${userId}. Audio mentah tidak disimpan.`
      );
    }
  });
}

client.on("error", (error) => {
  failIfActive("Discord client error.", error);
});

client.on("shardError", (error) => {
  failIfActive("Discord gateway shard error.", error);
});

client.once(Events.ClientReady, async () => {
  // Penting: timer ready harus dihentikan setelah client siap.
  clearTimeout(readyTimer);
  readyTimer = null;

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.fetch(CHANNEL_ID);

    if (!channel || !channel.isVoiceBased()) {
      throw new Error(
        "TEST_VOICE_CHANNEL_ID bukan voice channel yang dapat diakses bot."
      );
    }

    const member = await guild.members.fetchMe();
    const permissions = channel.permissionsFor(member);

    if (
      !permissions ||
      !permissions.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
      ])
    ) {
      throw new Error(
        "Permission channel kurang: View Channel dan Connect diperlukan."
      );
    }

    log(
      "INFO",
      `Bot ready: ${client.user.tag}; join #${channel.name}; menunggu pengguna bicara sampai ${TIMEOUT_MS} ms.`
    );

    log(
      "INFO",
      "Minta pengguna uji berbicara selama 3-5 detik lalu berhenti. Audio tidak ditulis ke file."
    );

    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });

    connection.on("error", (error) => {
      failIfActive(
        "VoiceConnection error (periksa koneksi, permission, dan negosiasi DAVE).",
        error
      );
    });

    await entersState(
      connection,
      VoiceConnectionStatus.Ready,
      30_000
    );

    log(
      "INFO",
      `VoiceConnection Ready; receiver tersedia=${Boolean(connection.receiver)}; sample rate decoder=${SAMPLE_RATE} Hz; channels=${CHANNELS}; format PCM=signed 16-bit little-endian.`
    );

    if (
      !connection.receiver ||
      typeof connection.receiver.subscribe !== "function"
    ) {
      throw new Error(
        "VoiceConnection.receiver.subscribe tidak tersedia."
      );
    }

    connection.receiver.speaking.on(
      "start",
      startSubscription
    );

  } catch (error) {
    failIfActive(
      "Gagal setup receiver Discord.",
      error
    );
  }
});

watchdog = setTimeout(() => {
  const detail = subscriptions.size
    ? ` Ada subscription aktif (${subscriptions.size}), tetapi belum ada stream audio lengkap yang berhasil ditutup.`
    : " Tidak ada event speaking/audio; cek user uji, channel, permission, selfDeaf, dependency voice/DAVE, dan firewall/UDP.";

  failIfActive(
    `Timeout setelah ${TIMEOUT_MS} ms menunggu Opus dan hasil decode.${detail}`
  );
}, TIMEOUT_MS);

readyTimer = setTimeout(() => {
  failIfActive(
    "Discord client belum ready sebelum batas 30 detik."
  );
}, 30_000);

client.login(TOKEN).catch((error) => {
  failIfActive("Discord login gagal.", error);
});
