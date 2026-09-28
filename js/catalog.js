// Device/firmware catalog: static config (config*.json) merged with GitHub releases served by /releases
import { configName } from './site.js?v=openhop14';
import { fetchJson } from './util.js?v=openhop14';
import { releaseTagAtLeast } from '/lib/version.js?v=openhop14';

// Display order and headings of firmware groups on the "choose role" screen
export const firmwareClasses = {
  openhop: {
    title: 'openHop Modem Firmware',
    tooltip: 'openHop Modem firmware from the openHop modem repository',
  },
};

// A firmware entry names its release source with a "github*" key, e.g. "github-zephcore": { type, files }
const releaseSourceKey = (firmware) => Object.keys(firmware).find(key => key.startsWith('github'));

// Builds firmware.version from releases: { [version]: { notes, files: [{ type, name, title }] } }
// `source.files` maps file type (flash, flash-wipe, flash-update, download) to a filename regex.
function matchReleaseFiles(releases, source, sourceKey) {
  const patterns = Object.entries(source.files).map(([type, re]) => [type, new RegExp(re)]);
  const versions = {};

  for(const [type, re] of patterns) {
    for(const release of releases) {
      if(release.type !== source.type) continue;
      const version = versions[release.version] ??= { notes: release.notes, files: [] };

      for(const file of release.files) {
        if(!re.test(file.name)) continue;
        version.files.push({ type, name: `${file.url}?repo=${sourceKey}`, title: file.name });
      }
    }
  }

  for(const [name, version] of Object.entries(versions)) {
    if(version.files.length === 0) delete versions[name];
  }

  return versions;
}

export const hasVersions = (firmware) => Object.values(firmware.version ?? {}).some(v => v.files.length > 0);

export async function loadCatalog() {
  const config = await fetchJson(`/${configName}.json`, { cache: 'no-store' });
  const firmwares = config.device.flatMap(device => device.firmware);

  const sourceKeys = new Set(firmwares.map(releaseSourceKey).filter(Boolean));
  const releases = Object.fromEntries(await Promise.all(
    [...sourceKeys].map(async key => [key, await fetchJson(`/releases?repo=${key}`)])
  ));

  for(const firmware of firmwares) {
    const key = releaseSourceKey(firmware);
    if(!firmware[key]?.files) continue;
    firmware.version = matchReleaseFiles(releases[key], firmware[key], key);
  }

  await expandFirmwareReleases(config);

  for(const device of config.device) device.firmware = device.firmware.filter(hasVersions);
  config.device = config.device.filter(device => device.firmware.length > 0);

  return config;
}

// Firmware title/icon/tooltip fall back to its role's defaults
export const roleValue = (config, firmware, key) => firmware[key] ?? config.role[firmware.role]?.[key] ?? '';

// Notices may reference device fields, e.g. ${bootloader} (arrays use their first item)
export function renderNotice(config, device, firmware) {
  const notice = config.notice?.[firmware.notice] || firmware.notice || '';

  return notice.replaceAll(/\$\{(\w+)\}/g, (_, field) => {
    const value = device[field];
    return (Array.isArray(value) ? value[0] : value) || '';
  });
}

export function formatChangeLog(changelog) {
  return changelog
    .replace(/^Release notes:'/, '')
    .replace(/change log:\r?\n/i, '')
    .replaceAll(/^[-*] /mg, '')
    .replaceAll(/(?<!["'])(https?:\/\/[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*))/gi, `<a target="_blank" href="$1">$1</a>`)
    .replaceAll(/#(\d+)/gm, `<a target="_blank" href="https://github.com/meshcore-dev/MeshCore/pull/$1">#$1</a>`);
}

export function firmwareUrl(config, file, version) {
  if(file.name.startsWith('/') || /^https?:\/\//.test(file.name)) return file.name;
  const base = version?.ref ? config.staticPath.replace('/main/firmware', `/${version.ref}/firmware`) : config.staticPath;
  return `${base}/${file.name}`;
}

const isStableTag = tag => /^v\d+\.\d+\.\d+$/.test(tag);
const newestTagFirst = (a, b) => a === b ? 0 : releaseTagAtLeast(a, b) ? -1 : 1;

export async function getFirmwareReleases(config) {
  const source = config.firmwareReleases;
  if(!source?.api || !source.tagPattern) return [];
  const pattern = new RegExp(source.tagPattern);
  const normalize = releases => [...new Set(releases
    .filter(r => r && !r.draft && !r.prerelease && isStableTag(r.tag_name) && pattern.test(r.tag_name))
    .map(r => r.tag_name))]
    .sort(newestTagFirst)
    .map(tag_name => ({ tag_name, html_url: `${source.releaseBaseUrl}${tag_name}` }));
  const key = `firmware-releases:${source.api}`;
  try {
    const cached = JSON.parse(localStorage.getItem(key) || 'null');
    if(cached?.fetchedAt > Date.now() - 15 * 60 * 1000 && Array.isArray(cached.releases)) {
      return normalize(cached.releases);
    }
  } catch { /* Corrupt/disabled storage must not prevent release discovery. */ }
  try {
    const releases = normalize(await fetchJson(source.api, { headers: { Accept: 'application/json' } }));
    try { localStorage.setItem(key, JSON.stringify({ fetchedAt: Date.now(), releases })); } catch { /* private browsing */ }
    return releases;
  } catch(error) {
    console.warn('Could not refresh firmware releases; using configured fallback tags.', error);
    return normalize((source.fallbackTags ?? []).map(tag_name => ({ tag_name })));
  }
}

export async function expandFirmwareReleases(config) {
  const releases = await getFirmwareReleases(config);
  for(const device of config.device) {
    for(const firmware of device.firmware) {
      // main describes the layout only; never retain it as a selectable version.
      const main = firmware.version?.main;
      const versions = {};
      for(const release of releases) {
        if(!releaseTagAtLeast(release.tag_name, firmware.minimumRelease)) continue;
        const template = firmware.version?.[release.tag_name]
          ?? (firmware.expandReleases !== false ? main : null);
        if(!template?.files?.length) continue;
        versions[release.tag_name] = {
          ...structuredClone(template), ref: release.tag_name, releaseUrl: release.html_url,
          notes: `Release ${release.tag_name}. Open the release page for the full changelog.`,
        };
      }
      firmware.version = versions;
    }
  }
}

export function defaultFirmwareVersion(firmware) {
  const versions = Object.keys(firmware?.version ?? {})
    .filter(v => isStableTag(v) && firmware.version[v].files?.length)
    .sort(newestTagFirst);
  return versions[0] ?? null;
}

export const compareDevices = (a, b) => ((a.order ?? 1000) - (b.order ?? 1000))
  || a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
