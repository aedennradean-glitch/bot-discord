"use strict";

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const FRAME_SAMPLES = 960; // 20 ms at 48 kHz
const BYTES_PER_SAMPLE = 2;

function log(level, message) {
  console.log(`${new Date().toISOString()} [${level}] ${message}`);
}

function fail(message, error) {
  log("FAIL", message);
  if (error) log("ERROR", error.stack || error.message || String(error));
  process.exitCode = 1;
}

try {
  const { OpusEncoder } = require("@discordjs/opus");
  if (typeof OpusEncoder !== "function") throw new Error("@discordjs/opus tidak mengekspor OpusEncoder.");

  const encoder = new OpusEncoder(SAMPLE_RATE, CHANNELS);
  const input = Buffer.alloc(FRAME_SAMPLES * CHANNELS * BYTES_PER_SAMPLE);
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE) * 12_000);
    input.writeInt16LE(sample, i * CHANNELS * BYTES_PER_SAMPLE);
    input.writeInt16LE(sample, (i * CHANNELS + 1) * BYTES_PER_SAMPLE);
  }

  const opus = encoder.encode(input, FRAME_SAMPLES);
  if (!Buffer.isBuffer(opus) || opus.length === 0) throw new Error("Encoder tidak menghasilkan paket Opus.");
  const pcm = encoder.decode(opus);
  if (!Buffer.isBuffer(pcm) || pcm.length === 0) throw new Error("Decoder tidak menghasilkan PCM.");
  if (pcm.length % (CHANNELS * BYTES_PER_SAMPLE) !== 0) {
    throw new Error(`PCM bytes ${pcm.length} bukan kelipatan 4 (stereo s16le).`);
  }

  const decodedSamplesPerChannel = pcm.length / (CHANNELS * BYTES_PER_SAMPLE);
  if (![120, 240, 480, 960, 1920, 2880].includes(decodedSamplesPerChannel)) {
    throw new Error(`Ukuran frame PCM tidak valid: ${decodedSamplesPerChannel} sampel/channel.`);
  }

  log("INFO", `Decoder: @discordjs/opus OpusEncoder(${SAMPLE_RATE}, ${CHANNELS}).`);
  log("INFO", `Input: PCM s16le, ${SAMPLE_RATE} Hz, stereo, ${input.length} bytes (${FRAME_SAMPLES} sampel/channel).`);
  log("INFO", `Opus: ${opus.length} bytes; decoded PCM: ${pcm.length} bytes (${decodedSamplesPerChannel} sampel/channel).`);
  log("PASS", "Opus test encode/decode menghasilkan PCM s16le stereo yang valid pada konfigurasi 48 kHz.");
} catch (error) {
  fail("Opus test gagal. Pastikan dependency terpasang dan binary native dapat dimuat.", error);
}
