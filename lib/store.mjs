// What the bridge itself remembers: settings, paired devices, per-session choices of model and effort.
// The conversations are Claude Code's own files (lib/transcripts.mjs).
import fs from 'node:fs';
import path from 'node:path';

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Settings the phone can change; everything else is in config.json (lib/config.mjs).
export const DEFAULT_SETTINGS = {
  pushOnFinish: true,
  phoneNote: false,
};

export class Store {
  constructor(dir) {
    this.dir = dir;
    for (const d of ['', 'uploads']) fs.mkdirSync(path.join(dir, d), { recursive: true });
    this.settings = { ...DEFAULT_SETTINGS, ...this.read('settings.json', {}) };
    this.devices = this.read('devices.json', []);
    this.prefs = this.read('prefs.json', {});
    this.dismissed = this.read('dismissed.json', []);
  }

  read(name, fallback) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
    } catch {
      return fallback;
    }
  }

  write(name, value) {
    const file = path.join(this.dir, name);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
    for (let i = 0; ; i++) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (e) {
        if (i >= 4) {
          fs.writeFileSync(file, JSON.stringify(value, null, 1));
          fs.rmSync(tmp, { force: true });
          return;
        }
        sleepSync(40 * (i + 1));
      }
    }
  }

  saveDevices() {
    this.write('devices.json', this.devices);
  }

  saveSettings() {
    this.write('settings.json', this.settings);
  }

  savePrefs() {
    this.write('prefs.json', this.prefs);
  }

  dismiss(id) {
    this.dismissed = [...this.dismissed.filter((d) => d !== id), id].slice(-300);
    this.write('dismissed.json', this.dismissed);
  }

  uploadsDir(key) {
    const d = path.join(this.dir, 'uploads', key);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
}
