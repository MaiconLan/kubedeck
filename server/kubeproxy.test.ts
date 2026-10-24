import assert from 'node:assert/strict';
import { test } from 'node:test';
import { httpErrorMessage, parseProxyPort } from './kubeproxy.js';
import { classifyStderr } from './errors.js';

test('parseProxyPort reads the port from the startup line', () => {
  assert.equal(parseProxyPort('Starting to serve on 127.0.0.1:54321\n'), 54321);
  assert.equal(parseProxyPort('Starting to serve on [::1]:8001\r\n'), 8001);
});

test('parseProxyPort waits for the complete line', () => {
  assert.equal(parseProxyPort('Starting to serve on 127.0.0.1:54'), undefined);
  assert.equal(parseProxyPort(''), undefined);
});

test('httpErrorMessage uses the status reason and message of the API body', () => {
  const body = JSON.stringify({ reason: 'Forbidden', message: 'pods is forbidden: User "u" cannot list resource "pods"' });
  assert.equal(httpErrorMessage(403, body), 'Error from server (Forbidden): pods is forbidden: User "u" cannot list resource "pods"');
});

test('httpErrorMessage falls back to the status name and a non-JSON body', () => {
  assert.equal(httpErrorMessage(503, 'unavailable'), 'Error from server (Service Unavailable): unavailable');
  assert.equal(httpErrorMessage(404, ''), 'Error from server (NotFound): NotFound');
  assert.equal(httpErrorMessage(418, ''), 'Error from server (418): 418');
});

test('proxy error messages are classified like kubectl failures', () => {
  const forbidden = httpErrorMessage(403, JSON.stringify({ reason: 'Forbidden', message: 'denied' }));
  assert.equal(classifyStderr(forbidden, 'cmd').kind, 'forbidden');
  assert.equal(classifyStderr(httpErrorMessage(401, JSON.stringify({ reason: 'Unauthorized' })), 'cmd').kind, 'auth');
  assert.equal(classifyStderr(httpErrorMessage(404, JSON.stringify({ reason: 'NotFound', message: 'x' })), 'cmd').kind, 'notfound');
});
