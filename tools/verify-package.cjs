'use strict';
// Unpacks the built IPK and confirms every app/service file is byte-identical to this source tree.
// Writes dist/SHA256SUMS.txt and dist/source-verification.json. Needs the system `ar` and `tar`.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const appInfo = JSON.parse(fs.readFileSync(path.join(root, 'app/appinfo.json'), 'utf8'));
const name = `${appInfo.id}_${appInfo.version}_all.ipk`;
const ipk = path.join(root, 'dist', name);
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function walk(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ?
    walk(path.join(dir, entry.name), prefix + entry.name + '/') : [prefix + entry.name]).sort();
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'anishelf-ipk-'));
try {
  execFileSync('ar', ['x', ipk], { cwd: temp });
  execFileSync('tar', ['xzf', 'data.tar.gz'], { cwd: temp });
  const services = JSON.parse(fs.readFileSync(path.join(root, 'service/services.json'), 'utf8'));
  const trees = [['app', `usr/palm/applications/${appInfo.id}`], ['service', `usr/palm/services/${services.id}`]];
  const files = [], problems = [];
  for (const [source, installed] of trees) {
    const sourceFiles = walk(path.join(root, source)), packaged = walk(path.join(temp, installed));
    for (const file of sourceFiles) {
      const original = path.join(root, source, file), copy = path.join(temp, installed, file);
      if (!fs.existsSync(copy)) { problems.push('missing from package: ' + source + '/' + file); continue; }
      const digest = sha(original);
      if (digest !== sha(copy)) problems.push('differs from source: ' + source + '/' + file);
      files.push({ path: source + '/' + file, sha256: digest });
    }
    for (const file of packaged) if (!sourceFiles.includes(file)) problems.push('extra file in package: ' + installed + '/' + file);
  }
  const report = { package: name, package_sha256: sha(ipk), all_source_bytes_match: problems.length === 0, problems, files };
  fs.writeFileSync(path.join(root, 'dist/source-verification.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'dist/SHA256SUMS.txt'), `${report.package_sha256}  ${name}\n`);
  console.log(`${name}\nsha256 ${report.package_sha256}\n${files.length} files compared; ${problems.length ? problems.join('\n') : 'all match the source tree'}`);
  if (problems.length) process.exitCode = 1;
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
