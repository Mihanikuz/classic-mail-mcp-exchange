import { localSecretSchema, secretSchema } from './config.js';
import { checkAccount } from './connection-check.js';
// Reads secret configuration only from stdin. Never print exception objects or inputs.
const chunks: Buffer[] = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 1024 * 1024) {
    console.log(JSON.stringify({ error: 'configuration_too_large' }));
    process.exit(1);
  }
  chunks.push(chunk);
}
try {
  const input = JSON.parse(Buffer.concat(chunks).toString());
  const secrets = ('googleClientId' in input ? secretSchema : localSecretSchema).parse(input);
  let passed = true;
  for (const account of secrets.accounts) {
    for (const result of await checkAccount(account)) {
      if (!result.ok) passed = false;
      console.log(JSON.stringify(result));
    }
  }
  if (!passed) process.exitCode = 1;
} catch {
  console.log(JSON.stringify({ error: 'invalid_configuration' }));
  process.exitCode = 1;
}
