// Import a server-issued ordinary operator session from stdin. No password accounts.
import {mkdir,writeFile,rename} from 'node:fs/promises';
import {dirname} from 'node:path';
const file=process.env.ANSUZ_CREDENTIALS_FILE;if(!file)throw Error('Set ANSUZ_CREDENTIALS_FILE.');
let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>16384)throw Error('Credential input too large');}
const config=JSON.parse(input);
if(config.origin!=='https://ansuz.jera.ink'||config.mode!=='operator-session'||config.session?.principal!=='operator:ansuz-recorder'||!config.session?.token||!Number.isFinite(config.session.expiresAt)||config.session.expiresAt<=Date.now())throw Error('Invalid operator session');
await mkdir(dirname(file),{recursive:true,mode:0o700});
// Preserve the earlier local credential file; never reinterpret its account.
try{await rename(file,file+'.retired-'+Date.now());}catch(e){if(e.code!=='ENOENT')throw e;}
await writeFile(file,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});console.log(config.session.principal);
