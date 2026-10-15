// Prints a bcrypt hash for ADMIN_PASSWORD_HASH: npm run set-password
// The password is typed without being shown and is never written anywhere.
import readline from 'node:readline';
import { hashPassword, PASSWORD_MIN } from '../src/auth.js';

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Hide what's typed.
    rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

const first = await ask('New password: ');
if (first.length < PASSWORD_MIN) {
  console.error(`Use at least ${PASSWORD_MIN} characters.`);
  process.exit(1);
}
const second = await ask('Same password again: ');
if (first !== second) {
  console.error("The passwords don't match.");
  process.exit(1);
}
console.log('\nSet this as ADMIN_PASSWORD_HASH (SiteGround: Site Tools > Node.js > Environment variables):\n');
console.log(await hashPassword(first));
