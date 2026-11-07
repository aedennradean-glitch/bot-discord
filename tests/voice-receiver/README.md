# Pengujian lokal Discord voice receiver (VS Code)

Pengujian ini hanya menguji decode Opus dan penerimaan audio Discord. Tidak menjalankan atau mengubah bot utama, tidak memanggil STT/TTS/music, dan tidak menyimpan audio mentah.

## Persyaratan

- Node.js **22.12.0 atau lebih baru** untuk pengujian dengan `@discordjs/voice` 0.19.x. Verifikasi versi yang benar-benar terpasang; jangan mengasumsikan range package.json sudah dipasang ke versi tertentu.
- npm dan akses jaringan.
- Bot uji di server Discord, voice channel uji, serta pengguna yang dapat berbicara.
- Permission bot: **View Channel**, **Connect**. Pengguna uji harus memberi persetujuan untuk audio singkat yang diproses selama pengujian.
- Hentikan proses bot lain yang memakai akun bot yang sama saat menjalankan tes. Lebih aman gunakan bot uji terpisah.

## Instalasi di terminal VS Code

Dari root repository pada branch `feature/aeden-voice-music`:

```sh
node --version
npm --version
npm install
npm install --no-save @discordjs/opus
npm ls discord.js @discordjs/voice @discordjs/opus
```

Jangan lanjut jika versi Node di bawah 22.12.0, install gagal, atau `npm ls` menunjukkan dependency invalid/missing. Repository belum menetapkan versi Opus decoder; `--no-save` memasang decoder hanya untuk workspace lokal dan tidak mengubah manifest package.json. `npm install` dapat membuat package-lock.json lokal karena repo awal tidak memiliki lockfile; jangan commit file itu sebagai hasil test tanpa meninjau perubahan.

## Test A — paket Opus sintetis encode/decode

```sh
node tests/voice-receiver/opus-loopback.js
```

Test ini menghasilkan frame sinusoidal PCM uji 20 ms, encode lalu decode melalui `@discordjs/opus`, dan memeriksa bentuk PCM. Ini menguji modul decoder lokal, **bukan** penerimaan paket dari Discord.

PASS yang diharapkan: log `PASS`, Opus tidak kosong, dan output buffer PCM valid. FAIL akan mencetak error/stack dan menetapkan exit code bukan nol.

## Test B — audio live dari Discord

Set environment variable berikut di terminal VS Code; jangan tulis nilainya ke file yang di-commit.

PowerShell:

```powershell
$env:DISCORD_TOKEN = "token bot uji"
$env:TEST_GUILD_ID = "ID server"
$env:TEST_VOICE_CHANNEL_ID = "ID voice channel uji"
$env:RECEIVER_TEST_TIMEOUT_MS = "90000"
node tests/voice-receiver/discord-receiver.js
```

macOS/Linux shell:

```sh
export DISCORD_TOKEN='token bot uji'
export TEST_GUILD_ID='ID server'
export TEST_VOICE_CHANNEL_ID='ID voice channel uji'
export RECEIVER_TEST_TIMEOUT_MS='90000'
node tests/voice-receiver/discord-receiver.js
```

Bot login, join voice, dan menunggu `VoiceConnectionStatus.Ready`. Setelah log meminta, satu pengguna uji bicara 3–5 detik lalu diam 1 detik. Script subscribe ke user ID yang memicu `speaking.start`, membaca `AudioPacket.payload` Opus, decode per packet, memeriksa buffer PCM, lalu menghapus subscription/connection. Ia tidak menyimpan audio atau payload ke file. Satu pengguna valid cukup untuk PASS; ulangi dengan pengguna kedua untuk memeriksa jalur per-user tambahan.

`RECEIVER_TEST_TIMEOUT_MS` opsional, 15000–300000 ms; default 90000. Keluaran bertimestamp `INFO`, `PASS`, `FAIL`, dan `ERROR`. Simpan hasil terminal secara lokal bila dibutuhkan; jangan bagikan token atau audio.

## Validasi PCM dan batasan interpretasi

Decoder dibuat dengan konfigurasi **48000 Hz, 2 channel**. `@discordjs/opus` menghasilkan raw PCM signed 16-bit little-endian. Script live memvalidasi setiap buffer non-empty dan ukuran frame, yaitu kelipatan 4 byte (2 channel × 2 byte/sample) serta 120, 240, 480, 960, 1920, atau 2880 sampel per channel. Batas hasil decode per pengguna adalah 8 detik PCM. Karena PCM raw tidak membawa header, sample rate/channel berasal dari konfigurasi decoder dan bentuk buffer—bukan metadata yang bisa dibaca dari buffer itu sendiri.

Test live PASS hanya membuktikan audio berhasil diterima dan didekode pada sesi, channel, akun, dan versi dependency tersebut. Test tidak membuktikan dukungan semua voice channel/server atau jaminan stabilitas API receive Discord. Jika gagal, salin log error lengkap yang sudah disanitasi, serta output `node --version` dan `npm ls discord.js @discordjs/voice @discordjs/opus`; jangan sertakan token.
