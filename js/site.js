// openHop uses one branded catalogue; custom config names are sanitized.
const searchParams = new URLSearchParams(location.search);
export const logoFile = 'openhop_logo.png';
export const configName = (searchParams.get('config') ?? '').replaceAll(/[^a-z_-]/g, '') || 'config';
export const isIframe = Boolean(searchParams.get('iframe'));
