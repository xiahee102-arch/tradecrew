import test from 'node:test';
import assert from 'node:assert/strict';
import {codespacesOrigin, isLocalRequest} from '../scripts/local-config.mjs';

test('只有明确的 Codespaces 环境才能授权其精确转发域名', () => {
  const env = {CODESPACES: 'true', CODESPACE_NAME: 'quiet-project-123', GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev'};
  const origin = codespacesOrigin(8899, env);
  assert.equal(origin, 'https://quiet-project-123-8899.app.github.dev');
  assert.equal(codespacesOrigin(8899, {...env, CODESPACES: 'false'}), null);
  assert.equal(codespacesOrigin(8899, {...env, CODESPACE_NAME: '../foreign'}), null);
  assert.equal(isLocalRequest(new URL(origin).host, origin, 8899, origin), true);
  assert.equal(isLocalRequest('localhost:8899', origin, 8899, origin), true);
  assert.equal(isLocalRequest('other-project-8899.app.github.dev', origin, 8899, origin), false);
  assert.equal(isLocalRequest(new URL(origin).host, 'https://evil.test', 8899, origin), false);
  assert.equal(isLocalRequest('localhost:8899', 'http://localhost:8899', 8899), true);
  assert.equal(isLocalRequest(new URL(origin).host, origin, 8899), false);
});
