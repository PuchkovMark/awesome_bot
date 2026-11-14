import type { VK } from 'vk-io';
import { logger } from '../../../logger/index.js';

export const USER_INFO_SECTIONS = [
  'profile',
  'posts',
  'friends',
  'groups',
  'albums',
  'photos',
] as const;
export const POST_FILTERS = ['all', 'owner', 'others'] as const;
export const PROFILE_FIELDS = [
  'activities',
  'about',
  'blacklisted',
  'blacklisted_by_me',
  'books',
  'bdate',
  'can_be_invited_group',
  'can_post',
  'can_see_all_posts',
  'can_see_audio',
  'can_send_friend_request',
  'can_write_private_message',
  'career',
  'city',
  'common_count',
  'connections',
  'contacts',
  'country',
  'counters',
  'crop_photo',
  'domain',
  'education',
  'exports',
  'followers_count',
  'friend_status',
  'games',
  'has_mobile',
  'has_photo',
  'home_town',
  'interests',
  'is_favorite',
  'is_friend',
  'is_hidden_from_feed',
  'is_verified',
  'last_seen',
  'maiden_name',
  'military',
  'movies',
  'music',
  'nickname',
  'occupation',
  'online',
  'personal',
  'photo_50',
  'photo_100',
  'photo_200',
  'photo_200_orig',
  'photo_400_orig',
  'photo_id',
  'photo_max',
  'photo_max_orig',
  'quotes',
  'relation',
  'relatives',
  'schools',
  'screen_name',
  'sex',
  'site',
  'status',
  'timezone',
  'tv',
  'universities',
  'verified',
] as const;

const DEFAULT_PROFILE_FIELDS = [
  'screen_name',
  'domain',
  'sex',
  'bdate',
  'city',
  'country',
  'home_town',
  'occupation',
  'status',
  'about',
  'activities',
  'interests',
  'music',
  'movies',
  'books',
  'online',
  'last_seen',
  'verified',
] as const;

type UserInfoSection = (typeof USER_INFO_SECTIONS)[number];
type CollectionSection = Exclude<UserInfoSection, 'profile'>;
type ProfileField = (typeof PROFILE_FIELDS)[number];
type PostFilter = (typeof POST_FILTERS)[number];
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type Budget = { remaining: number; nodes: number; truncated: boolean };

export type UserInfoOptions = {
  sections: UserInfoSection[];
  profileFields: ProfileField[];
  offset: number;
  count: number;
  albumId: string;
  postFilter: PostFilter;
};

type UserInfoContext = {
  api: VK['api'];
  publicApi?: VK['api'];
  userId: number;
  peerId: number;
  senderId: string;
  options: UserInfoOptions;
  requireAccess: () => Promise<void>;
};

const DEFAULT_PAGE_SIZE = 10;
export const MAX_USER_INFO_PAGE_SIZE = 20;
export const MAX_USER_INFO_OFFSET = 2_147_483_627;
const MAX_SECTION_CHARS = 8_000;
const MAX_SECTION_NODES = 1_000;
const MAX_TEXT_CHARS = 1_000;
const MAX_NESTING = 5;
const MAX_NESTED_ITEMS = 20;
const MAX_OBJECT_FIELDS = 40;
const SECRET_FIELDS = new Set(['access_key', 'access_token', 'refresh_token']);

const PROFILE_FIELD_ALIASES: Partial<Record<ProfileField, readonly string[]>> = {
  contacts: ['mobile_phone', 'home_phone'],
  connections: ['skype', 'facebook', 'facebook_name', 'twitter', 'instagram', 'livejournal'],
  education: [
    'university',
    'university_name',
    'faculty',
    'faculty_name',
    'graduation',
    'education_form',
    'education_status',
  ],
};

const COLLECTION_FIELDS: Record<CollectionSection, readonly string[]> = {
  posts: [
    'id',
    'owner_id',
    'from_id',
    'date',
    'text',
    'post_type',
    'marked_as_ads',
    'attachments',
    'copy_history',
    'comments',
    'likes',
    'reposts',
    'views',
  ],
  friends: ['id', 'first_name', 'last_name', 'domain', 'screen_name', 'is_closed', 'deactivated'],
  groups: ['id', 'name', 'screen_name', 'type', 'is_closed'],
  albums: ['id', 'owner_id', 'title', 'description', 'size', 'created', 'updated'],
  photos: ['id', 'owner_id', 'album_id', 'date', 'text', 'width', 'height'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function parseSelection<T extends string>(value: unknown, allowed: readonly T[]): T[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > allowed.length)
    return undefined;
  const result: T[] = [];
  for (const item of value) {
    const match = allowed.find((candidate) => candidate === item);
    if (match === undefined || result.includes(match)) return undefined;
    result.push(match);
  }
  return result;
}

export function parseUserInfoOptions(input: Record<string, unknown>): UserInfoOptions | undefined {
  const sections: UserInfoSection[] | undefined =
    input.sections === undefined ? ['profile'] : parseSelection(input.sections, USER_INFO_SECTIONS);
  const profileFields =
    input.profile_fields === undefined
      ? [...DEFAULT_PROFILE_FIELDS]
      : parseSelection(input.profile_fields, PROFILE_FIELDS);
  if (!sections || !profileFields) return undefined;
  if (input.profile_fields !== undefined && !sections.includes('profile')) return undefined;
  if (
    input.offset !== undefined &&
    (sections.every((section) => section === 'profile') ||
      integer(input.offset) === undefined ||
      Number(input.offset) < 0 ||
      Number(input.offset) > MAX_USER_INFO_OFFSET)
  ) {
    return undefined;
  }
  if (
    input.count !== undefined &&
    (sections.every((section) => section === 'profile') ||
      integer(input.count) === undefined ||
      Number(input.count) < 1 ||
      Number(input.count) > MAX_USER_INFO_PAGE_SIZE)
  ) {
    return undefined;
  }
  if (input.album_id !== undefined) {
    if (
      !sections.includes('photos') ||
      typeof input.album_id !== 'string' ||
      !/^(?:profile|wall|-?[1-9]\d{0,14})$/u.test(input.album_id)
    ) {
      return undefined;
    }
  }
  const postFilter =
    input.post_filter === undefined
      ? 'all'
      : POST_FILTERS.find((filter) => filter === input.post_filter);
  if (!postFilter || (input.post_filter !== undefined && !sections.includes('posts'))) {
    return undefined;
  }
  return {
    sections,
    profileFields,
    offset: typeof input.offset === 'number' ? input.offset : 0,
    count: typeof input.count === 'number' ? input.count : DEFAULT_PAGE_SIZE,
    albumId: typeof input.album_id === 'string' ? input.album_id : 'profile',
    postFilter,
  };
}

// Рекурсивный sanitizer намеренно использует undefined как маркер пропуска значения.
// eslint-disable-next-line sonarjs/function-return-type
function sanitize(value: unknown, budget: Budget, depth = 0): JsonValue | undefined {
  if (budget.nodes <= 0) {
    budget.truncated = true;
    return undefined;
  }
  budget.nodes -= 1;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const limit = Math.min(MAX_TEXT_CHARS, budget.remaining);
    if (value.length > limit) budget.truncated = true;
    const result = value.slice(0, limit);
    budget.remaining -= result.length;
    return result;
  }
  if (depth >= MAX_NESTING && (Array.isArray(value) || isRecord(value))) {
    budget.truncated = true;
    return undefined;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_NESTED_ITEMS) budget.truncated = true;
    const result: JsonValue[] = [];
    for (const item of value.slice(0, MAX_NESTED_ITEMS)) {
      const safe = sanitize(item, budget, depth + 1);
      if (safe !== undefined) result.push(safe);
    }
    return result;
  }
  if (isRecord(value)) {
    const result = Object.create(null) as Record<string, JsonValue>;
    const entries = Object.entries(value).filter(
      ([key]) => /^[a-zA-Z0-9_]{1,60}$/u.test(key) && !SECRET_FIELDS.has(key),
    );
    if (entries.length > MAX_OBJECT_FIELDS) budget.truncated = true;
    for (const [key, item] of entries.slice(0, MAX_OBJECT_FIELDS)) {
      const safe = sanitize(item, budget, depth + 1);
      if (safe !== undefined) result[key] = safe;
    }
    return result;
  }
  return undefined;
}

function profileInfo(
  value: unknown,
  userId: number,
  requestedFields: readonly ProfileField[],
): { user: JsonValue; notReturned: string[]; truncated: boolean } {
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    !isRecord(value[0]) ||
    value[0].id !== userId
  ) {
    throw new Error('VK did not return the requested user');
  }
  const user = value[0];
  const keys = new Set([
    'id',
    'first_name',
    'last_name',
    'is_closed',
    'can_access_closed',
    'deactivated',
  ]);
  const notReturned: string[] = [];
  for (const field of requestedFields) {
    const names = [field, ...(PROFILE_FIELD_ALIASES[field] ?? [])];
    for (const name of names) keys.add(name);
    if (!names.some((name) => user[name] !== undefined)) notReturned.push(field);
  }
  const selected = Object.fromEntries(Object.entries(user).filter(([key]) => keys.has(key)));
  const budget: Budget = {
    remaining: MAX_SECTION_CHARS,
    nodes: MAX_SECTION_NODES,
    truncated: false,
  };
  const result = sanitize(selected, budget);
  if (!result || !isRecord(result)) throw new Error('VK returned an invalid user profile');
  return { user: result, notReturned, truncated: budget.truncated };
}

function collectionItem(
  section: CollectionSection,
  item: unknown,
  userId: number,
): Record<string, unknown> {
  if ((section === 'friends' || section === 'groups') && integer(item) !== undefined) {
    if (Number(item) <= 0) throw new Error('VK returned an invalid item ID');
    return { id: item };
  }
  if (!isRecord(item)) throw new Error('VK returned an invalid item');
  const id = integer(item.id);
  if (id === undefined || id === 0 || (section !== 'albums' && id < 0)) {
    throw new Error('VK returned an invalid item ID');
  }
  if (
    (section === 'posts' || section === 'albums' || section === 'photos') &&
    item.owner_id !== userId
  ) {
    throw new Error('VK returned an item belonging to a different user');
  }
  const selected = Object.fromEntries(
    COLLECTION_FIELDS[section]
      .filter((field) => item[field] !== undefined)
      .map((field) => [field, item[field]]),
  );
  if (section === 'posts') selected.url = `https://vk.com/wall${userId}_${id}`;
  if (section === 'photos') selected.url = `https://vk.com/photo${userId}_${id}`;
  return selected;
}

function collectionPage(
  value: unknown,
  section: CollectionSection,
  userId: number,
  options: UserInfoOptions,
): Record<string, unknown> {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new Error('VK returned an invalid collection');
  }
  const total = integer(value.count);
  if (
    total === undefined ||
    total < 0 ||
    value.items.length > options.count ||
    (value.items.length > 0 && options.offset + value.items.length > total) ||
    (value.items.length === 0 && options.offset < total)
  ) {
    throw new Error('VK returned an incomplete collection page');
  }
  const budget: Budget = {
    remaining: MAX_SECTION_CHARS,
    nodes: MAX_SECTION_NODES,
    truncated: false,
  };
  const items: JsonValue[] = [];
  for (const item of value.items) {
    if (items.length > 0 && (budget.remaining < 256 || budget.nodes < 20)) {
      budget.truncated = true;
      break;
    }
    const safe = sanitize(collectionItem(section, item, userId), budget);
    if (!safe || !isRecord(safe)) throw new Error('VK returned an invalid collection item');
    items.push(safe);
  }
  const nextOffset = options.offset + items.length;
  const hasMore = nextOffset < total;
  const offsetLimitReached = hasMore && nextOffset > MAX_USER_INFO_OFFSET;
  return {
    status: 'result',
    total,
    offset: options.offset,
    returned: items.length,
    has_more: hasMore,
    ...(hasMore && !offsetLimitReached ? { next_offset: nextOffset } : {}),
    ...(offsetLimitReached ? { offset_limit_reached: true } : {}),
    ...(section === 'photos' ? { album_id: options.albumId } : {}),
    ...(section === 'posts' ? { post_filter: options.postFilter } : {}),
    ...(budget.truncated ? { truncated: true } : {}),
    items,
  };
}

async function getCollection(
  api: VK['api'],
  section: CollectionSection,
  userId: number,
  options: UserInfoOptions,
): Promise<unknown> {
  const { offset, count } = options;
  switch (section) {
    case 'posts':
      return api.wall.get({ owner_id: userId, offset, count, filter: options.postFilter });
    case 'friends':
      return api.friends.get({ user_id: userId, offset, count, fields: ['domain'] });
    case 'groups':
      return api.groups.get({ user_id: userId, offset, count, extended: 1 });
    case 'albums':
      return api.photos.getAlbums({ owner_id: userId, offset, count });
    case 'photos':
      return api.photos.get({
        owner_id: userId,
        album_id: options.albumId,
        offset,
        count,
        rev: 1,
      });
  }
}

export async function getVkUserInfo(context: UserInfoContext): Promise<{
  status: 'result' | 'error';
  user?: JsonValue;
  sections: Record<string, unknown>;
}> {
  const { api, publicApi, userId, options } = context;
  const sections: Record<string, unknown> = {};
  let user: JsonValue | undefined;
  let succeeded = false;

  for (const section of options.sections) {
    await context.requireAccess();
    if (section !== 'profile' && !publicApi) {
      sections[section] = {
        status: 'error',
        message: 'Для этого раздела нужен сервисный ключ VK_SERVICE_TOKEN, он не настроен.',
      };
      continue;
    }
    try {
      if (section === 'profile') {
        // Схема vk-io не включает все поля, перечисленные в документации users.get.
        const response = await api.call<unknown>('users.get', {
          user_ids: String(userId),
          fields: options.profileFields.join(','),
        });
        const profile = profileInfo(response, userId, options.profileFields);
        user = profile.user;
        sections[section] = {
          status: 'result',
          requested_fields: options.profileFields,
          not_returned_fields: profile.notReturned,
          ...(profile.truncated ? { truncated: true } : {}),
        };
      } else if (publicApi) {
        const response = await getCollection(publicApi, section, userId, options);
        sections[section] = collectionPage(response, section, userId, options);
      }
      succeeded = true;
    } catch (error) {
      const code = isRecord(error) ? integer(error.code) : undefined;
      logger.warn(
        {
          peerId: context.peerId,
          senderId: context.senderId,
          section,
          errorName: error instanceof Error ? error.name : 'UnknownError',
          ...(code !== undefined ? { code } : {}),
        },
        'Unable to retrieve a VK user information section',
      );
      sections[section] = {
        status: 'error',
        message:
          section === 'profile'
            ? 'VK не предоставил профиль. Проверьте доступ ключа и настройки приватности.'
            : 'VK не предоставил этот раздел. Проверьте сервисный ключ, доступ метода и настройки приватности.',
        ...(code !== undefined ? { vk_error_code: code } : {}),
      };
    }
  }

  return { status: succeeded ? 'result' : 'error', ...(user ? { user } : {}), sections };
}
