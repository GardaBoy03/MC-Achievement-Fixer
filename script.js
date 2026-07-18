/* =========================================================
   MC Achievement Fixer
   Upload file world Minecraft Bedrock (.mcworld) secara utuh.
   .mcworld sebenarnya adalah file ZIP berisi level.dat, db/,
   dsb. Tool ini membuka zip tersebut (pakai JSZip), mencari
   level.dat di dalamnya, mengubah 1 flag byte NBT
   "hasBeenLoadedInCreative", "cheatsEnabled", dan "commandsEnabled",
   lalu membungkus ulang jadi .mcworld baru untuk diunduh.

   Semua proses berjalan 100% di browser (client-side),
   tidak ada data yang dikirim ke server manapun.
   ========================================================= */

const dropzone   = document.getElementById('dropzone');
const fileInput  = document.getElementById('fileInput');
const dropText   = document.getElementById('dropText');
const processBtn = document.getElementById('processBtn');
const resultArea = document.getElementById('resultArea');

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

    // Tag-tag yang menentukan status "Achievements Disabled" di Bedrock:
    // - hasBeenLoadedInCreative -> paling sering jadi penyebab, ke-trigger begitu
    //   world pernah dibuka di Creative mode (meski sudah balik ke Survival)
    // - cheatsEnabled / commandsEnabled -> aktif kalau "Allow Cheats" pernah ON
    // Ketiganya harus 0 (0b) supaya achievement bisa aktif lagi.
    const tagsToFix = ['hasBeenLoadedInCreative', 'cheatsEnabled', 'commandsEnabled'];

    tagsToFix.forEach(tagName => {
      const result = setNamedByteTag(levelDatBytes, tagName, 0);
      report.push({
        name: tagName,
        found: result.found,
        before: result.before,
        after: result.found ? 0 : null
      });
    });

    const anyFound = report.some(r => r.found);

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
  let html = '<div class="bubble result-bubble">';
  html += '<p><b>✅ World selesai diproses!</b></p><ul style="margin:8px 0 0 18px;">';
  report.forEach(r => {
    if (r.found) {
      html += `<li><code>${escapeHtml(r.name)}</code>: ${r.before} ➜ ${r.after}</li>`;
    } else {
      html += `<li><code>${escapeHtml(r.name)}</code>: tidak ditemukan (dilewati)</li>`;
    }
  });
  html += '</ul>';
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
  html += '<p>❌ Tag <code>hasBeenLoadedInCreative</code>, <code>cheatsEnabled</code>, maupun <code>commandsEnabled</code> tidak ditemukan di level.dat world ini.</p>';
  html += '<p style="margin-top:6px;">Kemungkinan world memang belum pernah menonaktifkan achievement (harusnya sudah aktif), atau struktur level.dat tidak standar.</p>';
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
