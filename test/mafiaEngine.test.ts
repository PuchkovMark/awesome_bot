import assert from 'node:assert/strict';
import test from 'node:test';
import {
  determineMafiaWinner,
  mafiaSettings,
  parseNightAction,
  resolveNightActions,
  roleComposition,
  shuffleRoles,
  tallyMafiaVotes,
  type MafiaPlayerState,
} from '../src/services/games/mafiaEngine.js';

function player(vkUserId: string, role: MafiaPlayerState['role'], alive = true): MafiaPlayerState {
  return { vkUserId, name: vkUserId, role, alive, selfHealUsed: false };
}

test('role composition stays within player count and includes a town role', () => {
  for (let difficulty = 1; difficulty <= 4; difficulty += 1) {
    const roles = roleComposition(10, mafiaSettings(difficulty as 1 | 2 | 3 | 4));
    assert.equal(roles.length, 10);
    assert.ok(roles.includes('villager'));
    assert.ok(roles.some((role) => role === 'mafia' || role === 'don'));
  }
});

test('role shuffling is deterministic with a supplied random source', () => {
  assert.deepEqual(
    shuffleRoles(['villager', 'mafia', 'doctor'], () => 0),
    ['mafia', 'doctor', 'villager'],
  );
  assert.throws(() => shuffleRoles(['villager', 'mafia'], () => 2), /вне диапазона/u);
});

test('night actions are accepted only for compatible roles and command forms', () => {
  assert.deepEqual(parseNightAction('убить 2', 'mafia'), { kind: 'kill', targetId: '2' });
  assert.deepEqual(parseNightAction('проверить 3', 'commissioner'), {
    kind: 'inspect',
    targetId: '3',
  });
  assert.deepEqual(parseNightAction('лечить 1', 'doctor'), { kind: 'save', targetId: '1' });
  assert.equal(parseNightAction('проверить 3', 'villager'), null);
});

test('night resolution applies doctor protection and keeps investigations private by actor', () => {
  const players = [
    player('mafia', 'mafia'),
    player('doctor', 'doctor'),
    player('commissioner', 'commissioner'),
    player('target', 'villager'),
  ];
  const result = resolveNightActions(players, {
    mafia: { kind: 'kill', targetId: 'target' },
    doctor: { kind: 'save', targetId: 'target' },
    commissioner: { kind: 'inspect', targetId: 'mafia' },
  });
  assert.deepEqual(result.eliminatedIds, []);
  assert.deepEqual(result.investigations, [
    { actorId: 'commissioner', targetId: 'mafia', result: 'мафия' },
  ]);
});

test('vote tally excludes ineligible voters and requires a unique leader', () => {
  const tie = tallyMafiaVotes(
    { one: 'target-a', two: 'target-b', outsider: 'target-a' },
    new Set(['one', 'two']),
    new Set(['target-a', 'target-b']),
  );
  assert.equal(tie.eliminatedId, null);
  assert.deepEqual(tie.counts, { 'target-a': 1, 'target-b': 1 });
});

test('winner conditions recognize town and parity victories', () => {
  assert.equal(determineMafiaWinner([player('town', 'villager')]), 'town');
  assert.equal(
    determineMafiaWinner([player('mafia', 'mafia'), player('town', 'villager')]),
    'mafia',
  );
  assert.equal(determineMafiaWinner([player('maniac', 'maniac')]), 'maniac');
});
