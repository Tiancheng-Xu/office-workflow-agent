import test from 'node:test';import assert from 'node:assert/strict';
import {allowedCloudOrigin} from '../src/cloud/origin.js';
test('preview origin accepts only an owned project deployment label, with HTTPS and no userinfo/port',()=>{
  const exact=['https://office-workflow-agent.baby2b.online','https://office-workflow-agent.pages.dev'];
  for(const url of [...exact,'https://ab12cd34.office-workflow-agent.pages.dev/api/session','https://tc-office-agent-65f44f4b.office-workflow-agent.pages.dev/legacy/form'])assert.equal(allowedCloudOrigin(url,exact,'office-workflow-agent'),true,url);
  for(const url of ['http://ab12cd34.office-workflow-agent.pages.dev','https://ab12cd34.office-workflow-agent.pages.dev:444','https://user:pass@ab12cd34.office-workflow-agent.pages.dev','https://ab12cd34.office-workflow-agent.pages.dev.evil.test','https://foo.evil.pages.dev','https://foo.bar.office-workflow-agent.pages.dev','https://office-workflow-agent.pages.dev.evil.test'])assert.equal(allowedCloudOrigin(url,exact,'office-workflow-agent'),false,url);
  assert.equal(allowedCloudOrigin('https://ab12cd34.office-workflow-agent.pages.dev',exact),false);
});
