/* =========================================================
   MC Achievement Fixer (Vue 3)
   Upload file world Minecraft Bedrock (.mcworld) secara utuh.
   .mcworld sebenarnya adalah file ZIP berisi level.dat, db/,
   world_behavior_packs.json, dsb. Tool ini:
   1) Membuka zip tersebut (pakai JSZip)
   2) Nol-kan flag byte NBT di level.dat: hasBeenLoadedInCreative,
      cheatsEnabled, commandsEnabled, experiments_ever_used,
      saved_with_toggled_experiments
   3) Mengosongkan world_behavior_packs.json & world_resource_packs.json
      (melepas add-on yang membuat achievement terkunci)
   4) Membungkus ulang jadi .mcworld baru untuk diunduh

   Semua proses berjalan 100% di browser (client-side),
   tidak ada data yang dikirim ke server manapun.

   UI di-render pakai Vue 3 (reactive state), sementara semua
   logika parsing NBT tetap fungsi murni di luar instance Vue.
   ========================================================= */

/* ---------------------------------------------------------
   Cari entry file apapun berdasarkan nama persis (case-insensitive),
   baik di root maupun nested di dalam zip.
--------------------------------------------------------- */
function findEntryByName(zip, fileName) {
  let candidate = null;
  const lowerTarget = fileName.toLowerCase();
  zip.forEach((relativePath, entry) => {
    if (entry.dir) return;
    const lower = relativePath.toLowerCase();
    if (lower === lowerTarget || lower.endsWith('/' + lowerTarget)) {
      candidate = entry;
    }
  });
  return candidate;
}

/* ---------------------------------------------------------
   Cari entry "level.dat" di dalam zip (root atau nested,
   dan hindari "level.dat_old")
--------------------------------------------------------- */
function findLevelDatEntry(zip) {
  let candidate = null;
  zip.forEach((relativePath, entry) => {
    if (entry.dir) return;
    const lower = relativePath.toLowerCase();
    if (lower.endsWith('/level.dat') || lower === 'level.dat') {
      candidate = entry;
    }
  });
  return candidate;
}

/* ---------------------------------------------------------
   Skip payload NBT generik berdasarkan tipe tag (dipakai untuk
   melompati tag yang bukan TAG_Byte di dalam compound "experiments",
   jaga-jaga kalau strukturnya berubah di versi game mendatang).
   Return: offset setelah payload.
--------------------------------------------------------- */
function skipNbtPayload(bytes, offset, type) {
  switch (type) {
    case 1: return offset + 1;                     // Byte
    case 2: return offset + 2;                      // Short
    case 3: return offset + 4;                      // Int
    case 4: return offset + 8;                      // Long
    case 5: return offset + 4;                      // Float
    case 6: return offset + 8;                      // Double
    case 7: {                                        // Byte Array
      const len = readInt32LE(bytes, offset);
      return offset + 4 + len;
    }
    case 8: {                                        // String
      const len = bytes[offset] | (bytes[offset + 1] << 8);
      return offset + 2 + len;
    }
    case 9: {                                        // List
      const elemType = bytes[offset];
      const count = readInt32LE(bytes, offset + 1);
      let pos = offset + 5;
      for (let k = 0; k < count; k++) pos = skipNbtPayload(bytes, pos, elemType);
      return pos;
    }
    case 10: {                                       // Compound
      let pos = offset;
      while (bytes[pos] !== 0x00) {
        const childType = bytes[pos];
        const nameLen = bytes[pos + 1] | (bytes[pos + 2] << 8);
        const payloadStart = pos + 3 + nameLen;
        pos = skipNbtPayload(bytes, payloadStart, childType);
      }
      return pos + 1; // lewati TAG_End
    }
    case 11: {                                       // Int Array
      const len = readInt32LE(bytes, offset);
      return offset + 4 + len * 4;
    }
    case 12: {                                       // Long Array
      const len = readInt32LE(bytes, offset);
      return offset + 4 + len * 8;
    }
    default: return offset + 1; // fallback, seharusnya tidak pernah terjadi
  }
}

function readInt32LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
}

/* ---------------------------------------------------------
   Cari TAG_Compound bernama "experiments", lalu matikan (set ke 0)
   SEMUA TAG_Byte yang ada langsung di dalamnya — apa pun namanya.
   Ini menangani toggle experimental apa pun yang sedang aktif,
   termasuk yang belum ada di daftar manual manapun.
--------------------------------------------------------- */
function disableAllExperiments(bytes) {
  const nameBytes = new TextEncoder().encode('experiments');
  const nameLen = nameBytes.length;
  const disabled = [];

  for (let i = 0; i < bytes.length - (3 + nameLen); i++) {
    if (bytes[i] !== 0x0a) continue; // TAG_Compound
    const len = bytes[i + 1] | (bytes[i + 2] << 8);
    if (len !== nameLen) continue;
    let match = true;
    for (let j = 0; j < nameLen; j++) {
      if (bytes[i + 3 + j] !== nameBytes[j]) { match = false; break; }
    }
    if (!match) continue;

    // Ketemu compound "experiments". Jalan di dalamnya.
    let pos = i + 3 + nameLen;
    while (bytes[pos] !== 0x00) {
      const childType = bytes[pos];
      const childNameLen = bytes[pos + 1] | (bytes[pos + 2] << 8);
      const childName = new TextDecoder().decode(bytes.slice(pos + 3, pos + 3 + childNameLen));
      const payloadStart = pos + 3 + childNameLen;

      if (childType === 0x01) { // TAG_Byte -> ini toggle experiment
        const before = bytes[payloadStart];
        if (before !== 0) {
          bytes[payloadStart] = 0;
          disabled.push({ name: childName, before });
        }
        pos = payloadStart + 1;
      } else {
        pos = skipNbtPayload(bytes, payloadStart, childType);
      }
    }

    return { found: true, disabled }; // hanya proses compound pertama yang cocok
  }

  return { found: false, disabled: [] };
}

/* ---------------------------------------------------------
   Sama seperti setNamedByteTag, tapi untuk TAG_Int (type 0x03),
   payload 4 byte little-endian. Dipakai untuk tag seperti GameType.
--------------------------------------------------------- */
function setNamedIntTag(bytes, tagName, newValue) {
  const nameBytes = new TextEncoder().encode(tagName);
  const nameLen = nameBytes.length;

  for (let i = 0; i < bytes.length - (3 + nameLen + 4); i++) {
    if (bytes[i] !== 0x03) continue; // TAG_Int

    const len = bytes[i + 1] | (bytes[i + 2] << 8);
    if (len !== nameLen) continue;

    let match = true;
    for (let j = 0; j < nameLen; j++) {
      if (bytes[i + 3 + j] !== nameBytes[j]) { match = false; break; }
    }
    if (!match) continue;

    const payloadIndex = i + 3 + nameLen;
    const before = (bytes[payloadIndex]) | (bytes[payloadIndex+1] << 8) | (bytes[payloadIndex+2] << 16) | (bytes[payloadIndex+3] << 24);
    bytes[payloadIndex]     = newValue & 0xff;
    bytes[payloadIndex + 1] = (newValue >> 8) & 0xff;
    bytes[payloadIndex + 2] = (newValue >> 16) & 0xff;
    bytes[payloadIndex + 3] = (newValue >> 24) & 0xff;
    return { found: true, before, index: payloadIndex };
  }

  return { found: false, before: null, index: -1 };
}

/* ---------------------------------------------------------
   Mencari tag NBT bertipe TAG_Byte dengan nama tertentu,
   lalu mengubah nilai payload-nya (in-place pada buffer).
   Format tag: [type=0x01][nameLen:int16 LE][name bytes][value:1 byte]
--------------------------------------------------------- */
function setNamedByteTag(bytes, tagName, newValue) {
  const nameBytes = new TextEncoder().encode(tagName);
  const nameLen = nameBytes.length;

  for (let i = 0; i < bytes.length - (3 + nameLen); i++) {
    if (bytes[i] !== 0x01) continue;

    const len = bytes[i + 1] | (bytes[i + 2] << 8);
    if (len !== nameLen) continue;

    let match = true;
    for (let j = 0; j < nameLen; j++) {
      if (bytes[i + 3 + j] !== nameBytes[j]) {
        match = false;
        break;
      }
    }
    if (!match) continue;

    const payloadIndex = i + 3 + nameLen;
    const before = bytes[payloadIndex];
    bytes[payloadIndex] = newValue;
    return { found: true, before, index: payloadIndex };
  }

  return { found: false, before: null, index: -1 };
}

function suggestOutputName(originalName) {
  const base = originalName.replace(/\.(mcworld|zip)$/i, '');
  return `${base}_fixed.mcworld`;
}

function gameTypeLabel(val) {
  const map = { 0: 'Survival', 1: 'Creative', 2: 'Adventure', 3: 'Spectator' };
  return map[val] !== undefined ? `${map[val]} (${val})` : val;
}

function nowTime() {
  const d = new Date();
  return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
}

let resultIdCounter = 0;

/* ---------------------------------------------------------
   Vue app
--------------------------------------------------------- */
const { createApp } = Vue;

createApp({
  data() {
    return {
      loggedIn: false,
      guestName: '',

      musicIcon: '🔇',
      musicDisabled: false,
      userPaused: false,

      isDragover: false,
      selectedFile: null,
      processing: false,

      toggles: {
        hasBeenLoadedInCreative: true,
        cheatsEnabled: true,
        commandsEnabled: true,
        gameType: true,
        experiments: true,
        education: true,
        hardcore: true,
        packs: true
      },

      results: []
    };
  },

  computed: {
    statusText() {
      if (!this.loggedIn) return 'online';
      return this.guestName ? `online • Tamu: ${this.guestName}` : 'online • Tamu';
    }
  },

  methods: {
    /* ---------- Login tamu ---------- */
    doGuestLogin() {
      this.loggedIn = true;
      this.$nextTick(() => this.setupBgm());
    },

    logout() {
      this.loggedIn = false;
      this.guestName = '';
      this.selectedFile = null;
      this.results = [];
    },

    /* ---------- BGM: true autoplay via trik muted -> unmute ---------- */
    setupBgm() {
      const bgmAudio = this.$refs.bgmAudio;
      if (!bgmAudio) return;

      bgmAudio.muted = true;
      bgmAudio.play()
        .then(() => this.updateMusicBtnIcon())
        .catch(() => this.updateMusicBtnIcon());

      const unmuteOnFirstInteraction = () => {
        if (this.userPaused) return;
        bgmAudio.muted = false;
        if (bgmAudio.paused) {
          bgmAudio.play().catch(() => {});
        }
        this.updateMusicBtnIcon();
      };

      document.addEventListener('click', unmuteOnFirstInteraction, { once: true });
      document.addEventListener('touchstart', unmuteOnFirstInteraction, { once: true });
    },

    updateMusicBtnIcon() {
      const bgmAudio = this.$refs.bgmAudio;
      if (!bgmAudio) return;
      if (bgmAudio.paused) {
        this.musicIcon = '🔇';
      } else {
        this.musicIcon = bgmAudio.muted ? '🔈' : '🔊';
      }
    },

    toggleMusic() {
      const bgmAudio = this.$refs.bgmAudio;
      if (!bgmAudio) return;

      if (bgmAudio.paused) {
        this.userPaused = false;
        bgmAudio.muted = false;
        bgmAudio.play().catch(() => {});
      } else if (bgmAudio.muted) {
        bgmAudio.muted = false;
      } else {
        this.userPaused = true;
        bgmAudio.pause();
      }
      this.updateMusicBtnIcon();
    },

    onAudioError() {
      this.musicIcon = '🚫';
      this.musicDisabled = true;
    },

    /* ---------- UI: pilih file ---------- */
    triggerFileInput() {
      this.$refs.fileInput.click();
    },

    onFileChange(e) {
      if (e.target.files.length > 0) {
        this.selectedFile = e.target.files[0];
      }
    },

    onDrop(e) {
      this.isDragover = false;
      if (e.dataTransfer.files.length > 0) {
        this.selectedFile = e.dataTransfer.files[0];
      }
    },

    /* ---------- Proses utama ---------- */
    async processWorld() {
      if (!this.selectedFile || this.processing) return;

      this.processing = true;

      try {
        const toggles = this.toggles;
        const arrayBuffer = await this.selectedFile.arrayBuffer();

        // Buka .mcworld sebagai arsip zip
        const zip = await JSZip.loadAsync(arrayBuffer);

        // Cari entry level.dat (biasanya di root, tapi cari juga kalau nested)
        const levelDatEntry = findLevelDatEntry(zip);

        if (!levelDatEntry) {
          this.pushError('File level.dat tidak ditemukan di dalam world ini. Pastikan file yang diupload adalah .mcworld / hasil zip folder world yang valid (bukan zip kosong atau salah folder).');
          return;
        }

        const levelDatBytes = await levelDatEntry.async('uint8array');

        const report = [];

        // === BAGIAN 1: Flag byte di level.dat ===
        // - hasBeenLoadedInCreative -> world pernah dibuka di Creative mode
        // - cheatsEnabled / commandsEnabled -> "Allow Cheats" pernah ON
        // - experiments_ever_used / saved_with_toggled_experiments -> pernah
        //   mengaktifkan salah satu Experimental Gameplay toggle (flag ini
        //   muncul otomatis begitu experiment pernah dinyalakan sekali saja).
        //   Kedua flag ini digabung dengan toggle "experiments" di UI karena
        //   sama-sama soal riwayat Experimental Gameplay.
        const tagsToFix = [
          'hasBeenLoadedInCreative',
          'cheatsEnabled',
          'commandsEnabled'
        ].filter(tagName => toggles[tagName]);

        if (toggles.experiments) {
          tagsToFix.push('experiments_ever_used', 'saved_with_toggled_experiments');
        }

        if (toggles.education) {
          tagsToFix.push('educationFeaturesEnabled');
        }

        tagsToFix.forEach(tagName => {
          const result = setNamedByteTag(levelDatBytes, tagName, 0);
          report.push({
            type: 'flag',
            name: tagName,
            found: result.found,
            before: result.before,
            after: result.found ? 0 : null
          });
        });

        // IsHardcore -> world pernah/masih diset sebagai Hardcore. Mode ini
        // mengunci difficulty ke Hard permanen & mematikan respawn (mati =
        // game over), yang menurut laporan beberapa pemain turut membuat
        // achievement tidak bisa didapat. Dipaksa ke 0 (non-hardcore).
        if (toggles.hardcore) {
          const hardcoreResult = setNamedByteTag(levelDatBytes, 'IsHardcore', 0);
          report.push({
            type: 'flag',
            name: 'IsHardcore (mode Hardcore dinonaktifkan)',
            found: hardcoreResult.found,
            before: hardcoreResult.before,
            after: hardcoreResult.found ? 0 : null
          });
        }

        // GameType (TAG_Int) -> 0 (Survival). Kalau world saat ini masih
        // default Creative, achievement tidak akan bisa didapat walau
        // semua flag riwayat di atas sudah 0.
        if (toggles.gameType) {
          const gameTypeResult = setNamedIntTag(levelDatBytes, 'GameType', 0);
          report.push({
            type: 'flag',
            name: 'GameType (mode dipaksa ke Survival)',
            found: gameTypeResult.found,
            before: gameTypeResult.found ? gameTypeResult.before : null,
            after: gameTypeResult.found ? 0 : null
          });
        }

        // Matikan SEMUA toggle experimental yang sedang aktif di compound
        // "experiments" — apa pun namanya (termasuk yang belum diketahui).
        if (toggles.experiments) {
          const expResult = disableAllExperiments(levelDatBytes);
          report.push({
            type: 'experiments',
            found: expResult.found,
            disabled: expResult.disabled
          });
        }

        // === BAGIAN 2: Lepas behavior pack & resource pack dari world ===
        // Add-on/behavior pack yang masih aktif di sebuah world membuat
        // achievement tetap terkunci walau semua flag di atas sudah 0.
        if (toggles.packs) {
          const packFiles = ['world_behavior_packs.json', 'world_resource_packs.json'];

          for (const fileName of packFiles) {
            const entry = findEntryByName(zip, fileName);
            if (!entry) {
              report.push({ type: 'pack', name: fileName, found: false });
              continue;
            }

            const text = await entry.async('string');
            let packCount = 0;
            try {
              const parsed = JSON.parse(text);
              packCount = Array.isArray(parsed) ? parsed.length : 0;
            } catch (e) {
              packCount = text.trim().length > 2 ? -1 : 0; // -1 = tidak bisa diparse tapi ada isi
            }

            if (packCount > 0 || packCount === -1) {
              zip.file(entry.name, '[]');
              report.push({ type: 'pack', name: fileName, found: true, removedCount: packCount });
            } else {
              report.push({ type: 'pack', name: fileName, found: true, removedCount: 0 });
            }
          }
        }

        const anyFlagFound = report.some(r => r.type === 'flag' && r.found);
        const anyPackRemoved = report.some(r => r.type === 'pack' && r.found && r.removedCount !== 0);
        const anyExpDisabled = report.some(r => r.type === 'experiments' && r.disabled && r.disabled.length > 0);
        const anyFound = anyFlagFound || anyPackRemoved || anyExpDisabled;

        if (!anyFound) {
          this.pushNotFound();
          return;
        }

        // Tulis kembali level.dat yang sudah dimodifikasi ke dalam zip
        zip.file(levelDatEntry.name, levelDatBytes);

        // Generate ulang file .mcworld
        const outBlob = await zip.generateAsync({
          type: 'blob',
          compression: 'DEFLATE',
          compressionOptions: { level: 6 }
        });

        const outName = suggestOutputName(this.selectedFile.name);
        this.pushSuccess(report, outBlob, outName);

      } catch (err) {
        console.error(err);
        this.pushError('Terjadi kesalahan saat membaca file. Pastikan file yang diupload adalah .mcworld / .zip world yang valid dan tidak corrupt.');
      } finally {
        this.processing = false;
      }
    },

    /* ---------- Bangun entri hasil untuk state Vue ---------- */
    pushSuccess(report, blob, outName) {
      const flagResults = report.filter(r => r.type === 'flag').map(r => ({
        name: r.name,
        found: r.found,
        beforeLabel: r.name.startsWith('GameType') ? gameTypeLabel(r.before) : r.before,
        afterLabel: r.name.startsWith('GameType') ? gameTypeLabel(r.after) : r.after
      }));
      const packResults = report.filter(r => r.type === 'pack');
      const expResults = report.filter(r => r.type === 'experiments');

      const expDisabledCount = expResults.reduce((sum, r) => sum + (r.disabled ? r.disabled.length : 0), 0);
      const packRemoved = packResults.some(r => r.found && r.removedCount !== 0);

      const downloadUrl = URL.createObjectURL(blob);

      this.results.push({
        id: ++resultIdCounter,
        kind: 'success',
        flagResults,
        packResults,
        expResults,
        expDisabledCount,
        packRemoved,
        downloadUrl,
        downloadName: outName,
        time: nowTime()
      });

      this.scrollResultsIntoView();
    },

    pushNotFound() {
      this.results.push({
        id: ++resultIdCounter,
        kind: 'notfound',
        time: nowTime()
      });
      this.scrollResultsIntoView();
    },

    pushError(message) {
      this.results.push({
        id: ++resultIdCounter,
        kind: 'error',
        message,
        time: nowTime()
      });
      this.scrollResultsIntoView();
    },

    scrollResultsIntoView() {
      this.$nextTick(() => {
        const chatArea = this.$refs.chatArea;
        if (chatArea) {
          chatArea.scrollTo({ top: chatArea.scrollHeight, behavior: 'smooth' });
        }
      });
    }
  }
}).mount('#app');
