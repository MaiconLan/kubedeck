import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiPath, type ApiResource } from './resources.js';

const res = (name: string, group: string, version: string, namespaced: boolean): ApiResource => ({
  name, group, version, namespaced, kind: '', shortNames: [], verbs: ['get', 'list'], type: group ? `${name}.${group}` : name,
});

const pods = res('pods', '', 'v1', true);
const nodes = res('nodes', '', 'v1', false);
const deployments = res('deployments', 'apps', 'v1', true);

test('core resources use /api and grouped ones /apis', () => {
  assert.equal(apiPath(pods, { ns: 'web' }), '/api/v1/namespaces/web/pods');
  assert.equal(apiPath(deployments, { ns: 'web' }), '/apis/apps/v1/namespaces/web/deployments');
});

test('no namespace or "*" lists across namespaces', () => {
  assert.equal(apiPath(pods, {}), '/api/v1/pods');
  assert.equal(apiPath(pods, { ns: '*' }), '/api/v1/pods');
});

test('cluster-scoped resources ignore the namespace', () => {
  assert.equal(apiPath(nodes, { ns: 'web' }), '/api/v1/nodes');
});

test('a name addresses one object', () => {
  assert.equal(apiPath(pods, { ns: 'web', name: 'api-0' }), '/api/v1/namespaces/web/pods/api-0');
  assert.equal(apiPath(nodes, { name: 'node-1' }), '/api/v1/nodes/node-1');
});

test('selectors are URL-encoded query parameters', () => {
  assert.equal(
    apiPath(pods, { ns: 'web', labels: 'app=api,tier!=db', fields: 'spec.nodeName=node-1' }),
    '/api/v1/namespaces/web/pods?labelSelector=app%3Dapi%2Ctier%21%3Ddb&fieldSelector=spec.nodeName%3Dnode-1',
  );
});

test('invalid namespace and object names are rejected', () => {
  assert.throws(() => apiPath(pods, { ns: '../secrets' }));
  assert.throws(() => apiPath(pods, { ns: 'web', name: 'a/b' }));
});
