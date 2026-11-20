export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject { readonly [key: string]: JsonValue }

/** JSON-представление корневой объектной схемы. Не валидирует keywords или данные. */
export interface ObjectParameterSchema extends JsonObject {
  readonly type: 'object';
}
