import { execFile } from 'node:child_process';
import { start } from './server.mjs';

try {
  const { server, config } = start({ demo: true, env: 'development' });
  server.once('listening', () => {
    if (process.env.CAP_NO_OPEN === '1') return;
    const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', config.baseUrl] : [config.baseUrl];
    execFile(command, args, { windowsHide: true }, (error) => {
      if (error) console.log('Abra o endereço indicado acima no navegador.');
    });
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
