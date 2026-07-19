/* =========================================================
   MC Achievement Fixer
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
   ========================================================= */

const dropzone   = document.getElementById('dropzone');
const fileInput  = document.getElementById('fileInput');
const dropText   = document.getElementById('dropText');
const processBtn = document.getElementById('processBtn');
const resultArea = document.getElementById('resultArea');

/* ---------- Panel changelog ---------- */
const changelogBtn     = document.getElementById('changelogBtn');
const changelogOverlay = document.getElementById('changelogOverlay');
const closeChangelog   = document.getElementById('closeChangelog');

changelogBtn.addEventListener('click', () => {
  changelogOverlay.classList.add('open');
});

closeChangelog.addEventListener('click', () => {
  changelogOverlay.classList.remove('open');
});

changelogOverlay.addEventListener('click', (e) => {
  if (e.target === changelogOverlay) {
    changelogOverlay.classList.remove('open');
  }
});

/* ---------- BGM: autoplay loop + toggle manual ---------- */
const bgmAudio = document.getElementById('bgmAudio');
const musicBtn = document.getElementById('musicBtn');

function updateMusicBtnIcon() {
  musicBtn.textContent = (bgmAudio.paused) ? '🔇' : '🔊';
}

function tryAutoplay() {
  const playPromise = bgmAudio.play();
  if (playPromise !== undefined) {
    playPromise
      .then(() => updateMusicBtnIcon())
      .catch(() => {
        // Browser memblokir autoplay dengan suara sebelum ada interaksi user.
        // Tunggu interaksi pertama (tap/klik di mana saja), lalu coba lagi.
        updateMusicBtnIcon();
        const resumeOnInteraction = () => {
          bgmAudio.play().then(updateMusicBtnIcon).catch(() => {});
          document.removeEventListener('click', resumeOnInteraction);
          document.removeEventListener('touchstart', resumeOnInteraction);
        };
        document.addEventListener('click', resumeOnInteraction, { once: true });
        document.addEventListener('touchstart', resumeOnInteraction, { once: true });
      });
  }
}

musicBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (bgmAudio.paused) {
    bgmAudio.play().catch(() => {});
  } else {
    bgmAudio.pause();
  }
  updateMusicBtnIcon();
});

bgmAudio.addEventListener('error', () => {
  musicBtn.title = 'File BGM.ogg belum ditemukan di Assets/Sounds/';
  musicBtn.textContent = '🚫';
  musicBtn.disabled = true;
});

// Coba autoplay begitu halaman siap
tryAutoplay();

let selectedFile = null;

/* ---------- UI: pilih file ---------- */

dropzone.addEventListener('click', () => fileInput.click());

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});

dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('dragover');
});

dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  if (e.dataTransfer.files.length > 0) {
    handleFileSelected(e.dataTransfer.files[0]);
  }
});

fileInput.addEventListener('change', (e) => {
  if (e.target.files.length > 0) {
    handleFileSelected(e.target.files[0]);
  }
});

function handleFileSelected(file) {
  selectedFile = file;
  dropText.innerHTML = `<span class="file-selected">✅ ${escapeHtml(file.name)}</span> (${(file.size/1024).toFixed(1)} KB)`;
  processBtn.disabled = false;
}

/* ---------- Proses utama ---------- */

processBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  processBtn.disabled = true;
  processBtn.textContent = 'Memproses world...';

  try {
    const arrayBuffer = await selectedFile.arrayBuffer();

    // Buka .mcworld sebagai arsip zip
    const zip = await JSZip.loadAsync(arrayBuffer);

    // Cari entry level.dat (biasanya di root, tapi cari juga kalau nested)
    const levelDatEntry = findLevelDatEntry(zip);

    if (!levelDatEntry) {
      renderError('File level.dat tidak ditemukan di dalam world ini. Pastikan file yang diupload adalah .mcworld / hasil zip folder world yang valid (bukan zip kosong atau salah folder).');
      return;
    }

    const levelDatBytes = await levelDatEntry.async('uint8array');

    const report = [];

    // === BAGIAN 1: Flag byte di level.dat ===
    // - hasBeenLoadedInCreative -> world pernah dibuka di Creative mode
    // - cheatsEnabled / commandsEnabled -> "Allow Cheats" pernah ON
    // - experiments_ever_used / saved_with_toggled_experiments -> pernah
    //   mengaktifkan salah satu Experimental Gameplay toggle (flag ini
    //   muncul otomatis begitu experiment pernah dinyalakan sekali saja)
    const tagsToFix = [
      'hasBeenLoadedInCreative',
      'cheatsEnabled',
      'commandsEnabled',
      'experiments_ever_used',
      'saved_with_toggled_experiments'
    ];

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

    // GameType (TAG_Int) -> 0 (Survival). Kalau world saat ini masih
    // default Creative, achievement tidak akan bisa didapat walau
    // semua flag riwayat di atas sudah 0.
    const gameTypeResult = setNamedIntTag(levelDatBytes, 'GameType', 0);
    report.push({
      type: 'flag',
      name: 'GameType (mode dipaksa ke Survival)',
      found: gameTypeResult.found,
      before: gameTypeResult.found ? gameTypeResult.before : null,
      after: gameTypeResult.found ? 0 : null
    });

    // Matikan SEMUA toggle experimental yang sedang aktif di compound
    // "experiments" — apa pun namanya (termasuk yang belum diketahui).
    const expResult = disableAllExperiments(levelDatBytes);
    report.push({
      type: 'experiments',
      found: expResult.found,
      disabled: expResult.disabled
    });

    // === BAGIAN 2: Lepas behavior pack & resource pack dari world ===
    // Add-on/behavior pack yang masih aktif di sebuah world membuat
    // achievement tetap terkunci walau semua flag di atas sudah 0.
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

    const anyFlagFound = report.some(r => r.type === 'flag' && r.found);
    const anyPackRemoved = report.some(r => r.type === 'pack' && r.found && r.removedCount !== 0);
    const anyExpDisabled = report.some(r => r.type === 'experiments' && r.disabled && r.disabled.length > 0);
    const anyFound = anyFlagFound || anyPackRemoved || anyExpDisabled;

    if (!anyFound) {
      renderNotFound(report);
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

    const outName = suggestOutputName(selectedFile.name);
    renderResult(report, outBlob, outName);

  } catch (err) {
    console.error(err);
    renderError('Terjadi kesalahan saat membaca file. Pastikan file yang diupload adalah .mcworld / .zip world yang valid dan tidak corrupt.');
  } finally {
    processBtn.disabled = false;
    processBtn.textContent = 'Proses World & Aktifkan Achievement';
  }
});

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

/* ---------- Render hasil ke chat ---------- */

function renderResult(report, blob, outName) {
  const flagResults = report.filter(r => r.type === 'flag');
  const packResults = report.filter(r => r.type === 'pack');
  const expResults = report.filter(r => r.type === 'experiments');

  let html = '<div class="bubble result-bubble">';
  html += '<p><b>✅ World selesai diproses!</b></p>';

  html += '<p style="margin-top:8px; font-size:13px;"><b>Experimental Gameplay:</b></p><ul style="margin:4px 0 0 18px;">';
  expResults.forEach(r => {
    if (!r.found) {
      html += `<li>Compound <code>experiments</code> tidak ditemukan (world tidak pakai experiment)</li>`;
    } else if (r.disabled.length === 0) {
      html += `<li>Ditemukan, tapi semua toggle sudah 0 (tidak ada yang aktif)</li>`;
    } else {
      r.disabled.forEach(d => {
        html += `<li><code>${escapeHtml(d.name)}</code>: dimatikan (${d.before} ➜ 0)</li>`;
      });
    }
  });
  html += '</ul>';

  html += '<p style="margin-top:8px; font-size:13px;"><b>Flag di level.dat:</b></p><ul style="margin:4px 0 0 18px;">';
  flagResults.forEach(r => {
    if (r.found) {
      const beforeLabel = r.name.startsWith('GameType') ? gameTypeLabel(r.before) : r.before;
      const afterLabel = r.name.startsWith('GameType') ? gameTypeLabel(r.after) : r.after;
      html += `<li><code>${escapeHtml(r.name)}</code>: ${beforeLabel} ➜ ${afterLabel}</li>`;
    } else {
      html += `<li><code>${escapeHtml(r.name)}</code>: tidak ditemukan (dilewati)</li>`;
    }
  });
  html += '</ul>';

  html += '<p style="margin-top:10px; font-size:13px;"><b>Behavior/Resource Pack:</b></p><ul style="margin:4px 0 0 18px;">';
  packResults.forEach(r => {
    if (!r.found) {
      html += `<li><code>${escapeHtml(r.name)}</code>: file tidak ada (world tidak pakai add-on)</li>`;
    } else if (r.removedCount > 0) {
      html += `<li><code>${escapeHtml(r.name)}</code>: ${r.removedCount} pack dilepas dari world</li>`;
    } else if (r.removedCount === -1) {
      html += `<li><code>${escapeHtml(r.name)}</code>: isi dikosongkan</li>`;
    } else {
      html += `<li><code>${escapeHtml(r.name)}</code>: sudah kosong, tidak ada pack aktif</li>`;
    }
  });
  html += '</ul>';

  const expDisabledCount = expResults.reduce((sum, r) => sum + (r.disabled ? r.disabled.length : 0), 0);
  if (expDisabledCount > 0) {
    html += '<p style="margin-top:8px; font-size:12.5px; color:var(--wa-teal-green);">✅ Toggle experimental di atas berhasil dimatikan di file. Berdasarkan pengujian, mematikan toggle ini <b>terbukti bisa mengaktifkan kembali achievement</b> untuk world yang sebelumnya terkunci karena Experimental Gameplay — walau dialog resmi Mojang menyebutnya permanen. Hasil bisa bervariasi tergantung versi game/perangkat, jadi tetap cek notifikasi achievement setelah masuk ke world.</p>';
  }

  const packRemoved = packResults.some(r => r.found && r.removedCount !== 0);
  if (packRemoved) {
    html += '<p style="margin-top:8px; font-size:12.5px; color:var(--wa-danger-text);">⚠️ Add-on/behavior pack dilepas dari world ini. Jika world bergantung pada blok/item custom dari pack tersebut, sebagian konten bisa hilang atau berubah jadi "unknown". Pastikan sudah backup!</p>';
  }

  html += '<p style="margin-top:8px;"><b>Cara pakai hasilnya:</b><br>';
  html += 'Cara termudah — tap file hasil download, Minecraft akan otomatis meng-import world ini sebagai world baru.<br><br>';
  html += 'Atau cara manual — ganti world lama kamu di folder:<br>';
  html += '<code>minecraftWorlds/&lt;nama-folder-world&gt;</code><br>';
  html += 'dengan isi hasil extract file ini.</p>';
  html += `<a class="download-btn" id="downloadLink" href="#">⬇️ Download ${escapeHtml(outName)}</a>`;
  html += '<span class="time">' + nowTime() + '</span></div>';

  const node = htmlToNode(html);
  resultArea.appendChild(node);

  const url = URL.createObjectURL(blob);
  const link = node.querySelector('#downloadLink');
  link.href = url;
  link.download = outName;

  node.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function renderNotFound(report) {
  let html = '<div class="bubble result-bubble error">';
  html += '<p>❌ Tidak ada flag achievement maupun behavior/resource pack yang perlu diperbaiki di world ini.</p>';
  html += '<p style="margin-top:6px;">Kemungkinan world memang belum pernah menonaktifkan achievement (harusnya sudah aktif), atau struktur world tidak standar.</p>';
  html += '<span class="time">' + nowTime() + '</span></div>';
  const node = htmlToNode(html);
  resultArea.appendChild(node);
  node.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function renderError(message) {
  const html = `<div class="bubble result-bubble error"><p>❌ ${escapeHtml(message)}</p><span class="time">${nowTime()}</span></div>`;
  const node = htmlToNode(html);
  resultArea.appendChild(node);
  node.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

/* ---------- Util ---------- */

function gameTypeLabel(val) {
  const map = { 0: 'Survival', 1: 'Creative', 2: 'Adventure', 3: 'Spectator' };
  return map[val] !== undefined ? `${map[val]} (${val})` : val;
}

function htmlToNode(html) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html.trim();
  return wrapper.firstChild;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function nowTime() {
  const d = new Date();
  return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
}
