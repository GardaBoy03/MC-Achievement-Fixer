/* =========================================================
   MC Achievement Fixer (Vue 3)
   Upload an entire Minecraft Bedrock world file (.mcworld).
   An .mcworld is actually a ZIP file containing level.dat, db/,
   world_behavior_packs.json, etc. This tool:
   1) Opens that zip (using JSZip)
   2) Zeroes out NBT byte flags in level.dat: hasBeenLoadedInCreative,
      cheatsEnabled, commandsEnabled, experiments_ever_used,
      saved_with_toggled_experiments
   3) Clears world_behavior_packs.json & world_resource_packs.json
      (removes add-ons that lock achievements)
   4) Repackages everything into a new .mcworld for download

   Everything runs 100% in the browser (client-side),
   no data is sent to any server.

   The UI is rendered with Vue 3 (reactive state), while all the
   NBT parsing logic stays as pure functions outside the Vue instance.
   ========================================================= */

/* ---------------------------------------------------------
   Find any file entry by its exact name (case-insensitive),
   either at the root or nested inside the zip.
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
   Find the "level.dat" entry inside the zip (root or nested,
   while avoiding "level.dat_old")
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
   Generic NBT payload skipper based on tag type (used to jump
   over tags that aren't TAG_Byte inside the "experiments"
   compound, just in case the structure changes in future game
   versions). Returns: offset after the payload.
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
      return pos + 1; // skip TAG_End
    }
    case 11: {                                       // Int Array
      const len = readInt32LE(bytes, offset);
      return offset + 4 + len * 4;
    }
    case 12: {                                       // Long Array
      const len = readInt32LE(bytes, offset);
      return offset + 4 + len * 8;
    }
    default: return offset + 1; // fallback, should never happen
  }
}

function readInt32LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
}

/* ---------------------------------------------------------
   Find the TAG_Compound named "experiments", then disable (set
   to 0) EVERY TAG_Byte found directly inside it — whatever its
   name. This handles any active experimental toggle, including
   ones not in any manual list.
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

    // Found the "experiments" compound. Walk through it.
    let pos = i + 3 + nameLen;
    while (bytes[pos] !== 0x00) {
      const childType = bytes[pos];
      const childNameLen = bytes[pos + 1] | (bytes[pos + 2] << 8);
      const childName = new TextDecoder().decode(bytes.slice(pos + 3, pos + 3 + childNameLen));
      const payloadStart = pos + 3 + childNameLen;

      if (childType === 0x01) { // TAG_Byte -> this is an experiment toggle
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

    return { found: true, disabled }; // only process the first matching compound
  }

  return { found: false, disabled: [] };
}

/* ---------------------------------------------------------
   Same as setNamedByteTag, but for TAG_Int (type 0x03),
   a 4-byte little-endian payload. Used for tags like GameType.
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
   Finds an NBT tag of type TAG_Byte with a given name, then
   changes its payload value (in-place in the buffer).
   Tag format: [type=0x01][nameLen:int16 LE][name bytes][value:1 byte]
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

/* ---------------------------------------------------------
   Find a TAG_String with a given name (e.g. "LevelName") and
   return its position + current value. Doesn't change anything —
   used to preview the world name before processing, and by
   setNamedStringTag below to actually perform the change.
   Tag format: [type=0x08][nameLen:int16 LE][name bytes][strLen:int16 LE][str bytes]
--------------------------------------------------------- */
function findNamedStringTag(bytes, tagName) {
  const nameBytes = new TextEncoder().encode(tagName);
  const nameLen = nameBytes.length;

  for (let i = 0; i < bytes.length - (3 + nameLen + 2); i++) {
    if (bytes[i] !== 0x08) continue; // TAG_String

    const len = bytes[i + 1] | (bytes[i + 2] << 8);
    if (len !== nameLen) continue;

    let match = true;
    for (let j = 0; j < nameLen; j++) {
      if (bytes[i + 3 + j] !== nameBytes[j]) { match = false; break; }
    }
    if (!match) continue;

    const payloadIndex = i + 3 + nameLen;
    const strLen = bytes[payloadIndex] | (bytes[payloadIndex + 1] << 8);
    const strStart = payloadIndex + 2;
    const value = new TextDecoder('utf-8').decode(bytes.slice(strStart, strStart + strLen));

    return { found: true, value, payloadIndex, strStart, strLen };
  }

  return { found: false, value: null };
}

/* ---------------------------------------------------------
   Changes the value of a TAG_String (e.g. "LevelName") to a new
   name. The new string's length is usually different from the
   old one, so it can't be changed in-place like byte/int tags —
   a new buffer is rebuilt instead (the slice before the tag +
   new length + new name + the slice after the tag). Returns a
   NEW buffer (the old bytes are no longer valid after this).
--------------------------------------------------------- */
function setNamedStringTag(bytes, tagName, newValue) {
  const found = findNamedStringTag(bytes, tagName);
  if (!found.found) {
    return { found: false, before: null, bytes };
  }

  const newValueBytes = new TextEncoder().encode(newValue);
  const newLen = newValueBytes.length;

  const head = bytes.slice(0, found.payloadIndex);
  const tail = bytes.slice(found.strStart + found.strLen);

  const newBytes = new Uint8Array(head.length + 2 + newLen + tail.length);
  newBytes.set(head, 0);
  newBytes[head.length] = newLen & 0xff;
  newBytes[head.length + 1] = (newLen >> 8) & 0xff;
  newBytes.set(newValueBytes, head.length + 2);
  newBytes.set(tail, head.length + 2 + newLen);

  return { found: true, before: found.value, bytes: newBytes };
}

/* ---------------------------------------------------------
   The level.dat header (first 8 bytes) stores: [version:int32 LE]
   [length of the NBT payload that follows:int32 LE]. If the
   buffer's length changes (e.g. because the world name changed),
   this number must be updated so the game can still read the
   whole file correctly.
--------------------------------------------------------- */
function fixLevelDatHeaderLength(bytes) {
  const payloadLen = bytes.length - 8;
  bytes[4] = payloadLen & 0xff;
  bytes[5] = (payloadLen >> 8) & 0xff;
  bytes[6] = (payloadLen >> 16) & 0xff;
  bytes[7] = (payloadLen >> 24) & 0xff;
  return bytes;
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

/* Toggle keys controlled by the "Achievement Active" master switch.
   renameWorld is intentionally excluded — it's a separate feature
   (renaming the world), not an achievement fix. */
const ACHIEVEMENT_TOGGLE_KEYS = [
  'hasBeenLoadedInCreative',
  'cheatsEnabled',
  'commandsEnabled',
  'gameType',
  'experiments',
  'education',
  'hardcore',
  'packs'
];

/* ---------------------------------------------------------
   Vue app
--------------------------------------------------------- */
const { createApp } = Vue;

createApp({
  data() {
    return {
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
        packs: true,
        renameWorld: false
      },

      showAdvanced: false,

      currentWorldName: '',
      newWorldName: '',
      nameCheckPending: false,

      results: []
    };
  },

  computed: {
    /* 1 = not processed yet (including error/notfound, needs a
       fresh upload), 2 = currently processing, 3 = success & ready
       to download */
    currentStep() {
      if (this.processing) return 2;
      if (this.results.length) {
        const last = this.results[this.results.length - 1];
        if (last.kind === 'success') return 3;
      }
      return 1;
    },

    /* "Achievement Active" master switch. Reading it reflects whether
       every achievement-fix toggle below is currently on (renameWorld
       is a separate feature and isn't included); setting it flips all
       of them on or off at once for a quicker, more flexible workflow. */
    masterToggle: {
      get() {
        return ACHIEVEMENT_TOGGLE_KEYS.every(key => this.toggles[key]);
      },
      set(value) {
        ACHIEVEMENT_TOGGLE_KEYS.forEach(key => {
          this.toggles[key] = value;
        });
      }
    }
  },

  methods: {
    /* ---------- Feedback: open Gmail ---------- */
    openFeedback() {
      const email = 'fmuhammadgarda@gmail.com';
      const subject = 'Feedback MC Achievement Fixer';
      const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

      // Desktop: still open Gmail's web version in a new tab as before
      if (!isMobile) {
        window.open(
          `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}`,
          '_blank'
        );
        return;
      }

      // Mobile: try to open the Gmail app directly (not a browser tab)
      // via Gmail's official custom URL scheme. The subject is already
      // pre-filled with "Feedback MC Achievement Fixer" as a label for
      // this email.
      const gmailAppUrl = `googlegmail://co?to=${encodeURIComponent(email)}&subject=${encodeURIComponent(subject)}`;
      const mailtoFallback = `mailto:${email}?subject=${encodeURIComponent(subject)}`;

      let appOpened = false;
      const onHide = () => { appOpened = true; };
      document.addEventListener('visibilitychange', onHide, { once: true });

      window.location.href = gmailAppUrl;

      // If the page is still visible after a short delay (the Gmail
      // app isn't installed / failed to open), fall back to a regular
      // mailto: link so it can still be sent via the device's default
      // mail app.
      setTimeout(() => {
        document.removeEventListener('visibilitychange', onHide);
        if (!appOpened) {
          window.location.href = mailtoFallback;
        }
      }, 1200);
    },

    /* ---------- UI: pick a file ---------- */
    triggerFileInput() {
      this.$refs.fileInput.click();
    },

    onFileChange(e) {
      if (e.target.files.length > 0) {
        this.selectedFile = e.target.files[0];
        this.peekWorldName();
      }
    },

    onDrop(e) {
      this.isDragover = false;
      if (e.dataTransfer.files.length > 0) {
        this.selectedFile = e.dataTransfer.files[0];
        this.peekWorldName();
      }
    },

    /* ---------- Peek the current world name (read-only, doesn't change the file) ---------- */
    async peekWorldName() {
      this.currentWorldName = '';
      this.newWorldName = '';
      if (!this.selectedFile) return;

      this.nameCheckPending = true;
      try {
        const buf = await this.selectedFile.arrayBuffer();
        const zip = await JSZip.loadAsync(buf);
        const levelDatEntry = findLevelDatEntry(zip);
        if (!levelDatEntry) return;

        const bytes = await levelDatEntry.async('uint8array');
        const found = findNamedStringTag(bytes, 'LevelName');
        if (found.found) {
          this.currentWorldName = found.value;
          this.newWorldName = found.value;
        }
      } catch (e) {
        // A failed name peek just means the preview won't show;
        // the main processing step can still run afterward.
      } finally {
        this.nameCheckPending = false;
      }
    },

    /* ---------- Main processing ---------- */
    async processWorld() {
      if (!this.selectedFile || this.processing) return;

      this.processing = true;

      try {
        const toggles = this.toggles;
        const arrayBuffer = await this.selectedFile.arrayBuffer();

        // Open the .mcworld as a zip archive
        const zip = await JSZip.loadAsync(arrayBuffer);

        // Find the level.dat entry (usually at the root, but also search nested)
        const levelDatEntry = findLevelDatEntry(zip);

        if (!levelDatEntry) {
          this.pushError('The level.dat file was not found inside this world. Make sure the uploaded file is a valid .mcworld / a zip of a valid world folder (not an empty zip or the wrong folder).');
          return;
        }

        const levelDatBytes = await levelDatEntry.async('uint8array');

        const report = [];

        // === PART 1: Byte flags in level.dat ===
        // - hasBeenLoadedInCreative -> world was ever opened in Creative mode
        // - cheatsEnabled / commandsEnabled -> "Allow Cheats" was ever ON
        // - experiments_ever_used / saved_with_toggled_experiments -> any
        //   Experimental Gameplay toggle was ever enabled (this flag appears
        //   automatically as soon as an experiment has been turned on even
        //   once). Both flags are grouped with the "experiments" toggle in
        //   the UI since they're both about Experimental Gameplay history.
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

        // IsHardcore -> the world was ever/still set to Hardcore. This mode
        // permanently locks difficulty to Hard & disables respawn (dying =
        // game over), which according to some player reports also prevents
        // achievements from being earned. Forced to 0 (non-hardcore).
        if (toggles.hardcore) {
          const hardcoreResult = setNamedByteTag(levelDatBytes, 'IsHardcore', 0);
          report.push({
            type: 'flag',
            name: 'IsHardcore (Hardcore Mode disabled)',
            found: hardcoreResult.found,
            before: hardcoreResult.before,
            after: hardcoreResult.found ? 0 : null
          });
        }

        // GameType (TAG_Int) -> 0 (Survival). If the world is still set to
        // Creative by default, achievements won't unlock even if every
        // history flag above is already 0.
        if (toggles.gameType) {
          const gameTypeResult = setNamedIntTag(levelDatBytes, 'GameType', 0);
          report.push({
            type: 'flag',
            name: 'GameType (mode forced to Survival)',
            found: gameTypeResult.found,
            before: gameTypeResult.found ? gameTypeResult.before : null,
            after: gameTypeResult.found ? 0 : null
          });
        }

        // Disable EVERY experimental toggle currently active in the
        // "experiments" compound — whatever its name (including unknown ones).
        if (toggles.experiments) {
          const expResult = disableAllExperiments(levelDatBytes);
          report.push({
            type: 'experiments',
            found: expResult.found,
            disabled: expResult.disabled
          });
        }

        // === PART 2: Remove behavior pack & resource pack from the world ===
        // An add-on/behavior pack that's still active in a world keeps
        // achievements locked even if every flag above is already 0.
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
              packCount = text.trim().length > 2 ? -1 : 0; // -1 = couldn't be parsed but has content
            }

            if (packCount > 0 || packCount === -1) {
              zip.file(entry.name, '[]');
              report.push({ type: 'pack', name: fileName, found: true, removedCount: packCount });
            } else {
              report.push({ type: 'pack', name: fileName, found: true, removedCount: 0 });
            }
          }
        }

        // === PART 3: Rename the world (LevelName tag + levelname.txt) ===
        // Unlike the flags/ints above, TAG_String has a length that can
        // change, so it needs a new buffer (not in-place), and the
        // level.dat header (first 8 bytes) needs to be re-adjusted.
        let finalLevelDatBytes = levelDatBytes;
        if (toggles.renameWorld) {
          const newName = (this.newWorldName || '').trim();
          if (newName) {
            const renameResult = setNamedStringTag(finalLevelDatBytes, 'LevelName', newName);
            if (renameResult.found) {
              finalLevelDatBytes = fixLevelDatHeaderLength(renameResult.bytes);
              report.push({ type: 'rename', applied: true, found: true, before: renameResult.before, after: newName });

              // levelname.txt (if present) is also used by the game to
              // display the world name on the world-select screen, so
              // it's updated to match too.
              const levelNameTxtEntry = findEntryByName(zip, 'levelname.txt');
              if (levelNameTxtEntry) {
                zip.file(levelNameTxtEntry.name, newName);
              }
            } else {
              report.push({ type: 'rename', applied: false, found: false, before: null, after: newName });
            }
          }
        }

        const anyFlagFound = report.some(r => r.type === 'flag' && r.found);
        const anyPackRemoved = report.some(r => r.type === 'pack' && r.found && r.removedCount !== 0);
        const anyExpDisabled = report.some(r => r.type === 'experiments' && r.disabled && r.disabled.length > 0);
        const anyRenamed = report.some(r => r.type === 'rename' && r.applied);
        const anyFound = anyFlagFound || anyPackRemoved || anyExpDisabled || anyRenamed;

        if (!anyFound) {
          this.pushNotFound();
          return;
        }

        // Write the modified level.dat back into the zip
        zip.file(levelDatEntry.name, finalLevelDatBytes);

        // Regenerate the .mcworld file
        const outBlob = await zip.generateAsync({
          type: 'blob',
          compression: 'DEFLATE',
          compressionOptions: { level: 6 }
        });

        const outName = suggestOutputName(this.selectedFile.name);
        this.pushSuccess(report, outBlob, outName);

      } catch (err) {
        console.error(err);
        this.pushError('An error occurred while reading the file. Make sure the uploaded file is a valid .mcworld / world .zip and isn\'t corrupted.');
      } finally {
        this.processing = false;
      }
    },

    /* ---------- Build result entries for the Vue state ---------- */
    pushSuccess(report, blob, outName) {
      const flagResults = report.filter(r => r.type === 'flag').map(r => ({
        name: r.name,
        found: r.found,
        beforeLabel: r.name.startsWith('GameType') ? gameTypeLabel(r.before) : r.before,
        afterLabel: r.name.startsWith('GameType') ? gameTypeLabel(r.after) : r.after
      }));
      const packResults = report.filter(r => r.type === 'pack');
      const expResults = report.filter(r => r.type === 'experiments');
      const renameResult = report.find(r => r.type === 'rename' && r.applied) || null;

      const expDisabledCount = expResults.reduce((sum, r) => sum + (r.disabled ? r.disabled.length : 0), 0);
      const flagsFixedCount = flagResults.filter(f => f.found).length;
      const packsRemovedCount = packResults.filter(p => p.found && p.removedCount !== 0).length;
      const packRemoved = packResults.some(r => r.found && r.removedCount !== 0);

      const downloadUrl = URL.createObjectURL(blob);
      const downloadBaseName = outName.replace(/\.mcworld$/i, '');

      this.results.push({
        id: ++resultIdCounter,
        kind: 'success',
        flagResults,
        packResults,
        expResults,
        expDisabledCount,
        flagsFixedCount,
        packsRemovedCount,
        packRemoved,
        renameResult,
        downloadUrl,
        downloadBaseName,
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

    /* ---------- Keep the editable output file/folder name filesystem-safe ---------- */
    sanitizeOutputName(result) {
      let cleaned = (result.downloadBaseName || '')
        .replace(/[\\/:*?"<>|]/g, '')
        .trim();
      if (!cleaned) {
        cleaned = 'world_fixed';
      }
      result.downloadBaseName = cleaned;
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
