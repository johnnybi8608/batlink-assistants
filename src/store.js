// Local state per bot (JSON file, written atomically):
//   groups[groupId] = { record, epoch, isMember, announced, memberNames }
//
// Cards only move forward by epoch: while catching up, a newer card may arrive before an older message
// carrying an older card. The old one must not overwrite the new one, or new messages would be
// decrypted with an expired group key.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

// At most this many groups are kept; a new group beyond it is refused (the state file is rewritten on every change)
const MAX_GROUPS = 500;
const MAX_NAME_LENGTH = 64;

export class AgentStore {
  constructor(path) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { groups: {} };
    this.state.groups ??= {};
  }

  #flush() {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  #group(groupId) {
    this.state.groups[groupId] ??= { record: null, epoch: 0, isMember: false, announced: false, memberNames: {} };
    return this.state.groups[groupId];
  }

  /**
   * Save a card. joinedNow = we were just added to the group (so we should announce our display name).
   * @returns {{saved: boolean, joinedNow: boolean}}
   */
  saveCard(groupId, record, { isMember }) {
    if (!this.state.groups[groupId] && Object.keys(this.state.groups).length >= MAX_GROUPS) {
      return { saved: false, joinedNow: false };
    }
    const group = this.#group(groupId);
    const epoch = Number(record.card?.epoch ?? 0);
    if (group.record && epoch < group.epoch) return { saved: false, joinedNow: false };

    group.record = record;
    group.epoch = epoch;
    group.isMember = isMember;
    let joinedNow = false;
    if (isMember && !group.announced) {
      group.announced = true;
      joinedNow = true;
    }
    // Removed from the group: announce again the next time we are added
    if (!isMember) group.announced = false;
    this.#flush();
    return { saved: true, joinedNow };
  }

  /** Group nickname in this group (null = use the bot's default name) */
  nickname(groupId) {
    return this.state.groups[groupId]?.nickname ?? null;
  }

  setNickname(groupId, name) {
    this.#group(groupId).nickname = name;
    this.#flush();
  }

  /** Avatar used in the last announcement in this group (re-announce after the avatar changes) */
  announcedAvatar(groupId) {
    return this.state.groups[groupId]?.announcedAvatar ?? null;
  }

  setAnnouncedAvatar(groupId, avatar) {
    this.#group(groupId).announcedAvatar = avatar;
    this.#flush();
  }

  /** Manually mark as left: forget the group entirely so its slot is free (re-announce when added again) */
  markLeft(groupId) {
    return this.forget(groupId);
  }

  /** Drop all local state of a group (left or removed), freeing its slot */
  forget(groupId) {
    if (!this.state.groups[groupId]) return false;
    delete this.state.groups[groupId];
    this.#flush();
    return true;
  }

  getCard(groupId) {
    return this.state.groups[groupId]?.record ?? null;
  }

  // Names are cut to 64 characters; an unchanged name does not rewrite the file; unknown groups are not created
  setMemberName(groupId, memberRaw, name) {
    const group = this.state.groups[groupId];
    if (!group || !name) return;
    const trimmed = String(name).slice(0, MAX_NAME_LENGTH);
    group.memberNames ??= {};
    if (group.memberNames[memberRaw] === trimmed) return;
    group.memberNames[memberRaw] = trimmed;
    this.#flush();
  }

  /** Member display name: profile updates first, then the card's members; null if neither */
  memberName(groupId, memberRaw, card) {
    const fromUpdate = this.state.groups[groupId]?.memberNames?.[memberRaw];
    if (fromUpdate) return fromUpdate;
    const fromCard = card?.members?.find((m) => m.memberRawPublicKey === memberRaw)?.displayName;
    // The app's default display name is the public key itself; that does not count as a name
    return fromCard && fromCard !== memberRaw ? fromCard : null;
  }

  listGroups() {
    return Object.entries(this.state.groups)
      .filter(([, g]) => g.record)
      .map(([groupId, g]) => ({
        groupId,
        name: g.record.card.name,
        joinKey: g.record.card.adminPublicKey ?? null, // group link in the app: batlink:group:<joinKey>
        epoch: g.epoch,
        isMember: g.isMember,
        members: g.record.card.memberPublicKeys?.length ?? 0
      }));
  }
}
