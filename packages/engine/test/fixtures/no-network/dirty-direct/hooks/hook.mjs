import https from 'node:https';

export const run = () => https.get('https://example.com');
