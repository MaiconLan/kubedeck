import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareCommand } from './termargs.js';

const scope = { ctx: 'prod', ns: 'apps' };

test('kubectl gets the tab context and namespace', () => {
  const p = prepareCommand('kubectl', ['get', 'pods'], scope);
  assert.deepEqual(p.args, ['--context=prod', '--namespace=apps', 'get', 'pods']);
  assert.equal(p.ctx, 'prod');
  assert.equal(p.write, false);
});

test('flags given by the user win', () => {
  const p = prepareCommand('kubectl', ['--context', 'dev', '-n', 'kube-system', 'get', 'pods'], scope);
  assert.deepEqual(p.args, ['--context', 'dev', '-n', 'kube-system', 'get', 'pods']);
  assert.equal(p.ctx, 'dev');
  assert.deepEqual(prepareCommand('kubectl', ['get', 'pods', '-A'], scope).args, ['--context=prod', 'get', 'pods', '-A']);
  assert.deepEqual(prepareCommand('kubectl', ['get', 'pods', '-nweb'], scope).args, ['--context=prod', 'get', 'pods', '-nweb']);
  assert.deepEqual(prepareCommand('kubectl', ['get', 'pods', '--namespace=web'], scope).args, ['--context=prod', 'get', 'pods', '--namespace=web']);
});

test('all namespaces adds only the context', () => {
  assert.deepEqual(prepareCommand('kubectl', ['get', 'pods'], { ctx: 'prod', ns: '*' }).args, ['--context=prod', 'get', 'pods']);
});

test('flags after -- belong to the command in the container', () => {
  const p = prepareCommand('kubectl', ['exec', 'web-0', '--', 'ls', '-n'], scope);
  assert.deepEqual(p.args, ['--context=prod', '--namespace=apps', 'exec', 'web-0', '--', 'ls', '-n']);
  assert.equal(p.write, true);
});

test('local commands and plugins are left alone', () => {
  assert.deepEqual(prepareCommand('kubectl', ['config', 'get-contexts'], scope).args, ['config', 'get-contexts']);
  assert.equal(prepareCommand('kubectl', ['config', 'get-contexts'], scope).ctx, undefined);
  const plugin = prepareCommand('kubectl', ['neat', 'get', 'pod'], scope);
  assert.deepEqual(plugin.args, ['neat', 'get', 'pod']);
  assert.equal(plugin.write, true);
  assert.deepEqual(prepareCommand('kubectl', ['--kubeconfig', 'other', 'get', 'pods'], scope).args, ['--kubeconfig', 'other', 'get', 'pods']);
});

test('the verb is found after global flags with values', () => {
  assert.equal(prepareCommand('kubectl', ['--request-timeout', '5s', 'delete', 'pod', 'x'], scope).verb, 'delete');
  assert.equal(prepareCommand('kubectl', ['-v=6', 'get', 'pods'], scope).verb, 'get');
});

test('kubectl write detection', () => {
  const w = (...args: string[]) => prepareCommand('kubectl', args, scope).write;
  assert.equal(w('delete', 'pod', 'x'), true);
  assert.equal(w('apply', '-f', 'x.yaml'), true);
  assert.equal(w('scale', 'deploy/x', '--replicas=0'), true);
  assert.equal(w('rollout', 'restart', 'deploy/x'), true);
  assert.equal(w('rollout', 'status', 'deploy/x'), false);
  assert.equal(w('auth', 'can-i', 'get', 'pods'), false);
  assert.equal(w('auth', 'reconcile', '-f', 'x'), true);
  assert.equal(w('logs', 'x'), false);
  assert.equal(w(), false);
  assert.equal(w('--help'), false);
});

test('helm uses --kube-context and only on cluster commands', () => {
  const p = prepareCommand('helm', ['upgrade', 'web', './chart'], scope);
  assert.deepEqual(p.args, ['--kube-context=prod', '--namespace=apps', 'upgrade', 'web', './chart']);
  assert.equal(p.write, true);
  assert.equal(prepareCommand('helm', ['list'], scope).write, false);
  assert.deepEqual(prepareCommand('helm', ['repo', 'update'], scope).args, ['repo', 'update']);
  assert.equal(prepareCommand('helm', ['repo', 'update'], scope).write, false);
  assert.deepEqual(prepareCommand('helm', ['list', '-A'], scope).args, ['--kube-context=prod', 'list', '-A']);
});
