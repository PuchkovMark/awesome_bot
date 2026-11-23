import type { PersonaSnapshot } from '../../contracts/versioning';
import { personaSettingKeys, type PersonaCard } from './catalog';

export function starterPersonaCard(persona: PersonaSnapshot): PersonaCard | undefined {
  if (persona.starterId === null) return;
  const card = JSON.parse(persona.text) as PersonaCard | null;
  if (
    card?.id !== persona.starterId ||
    typeof card.name !== 'string' ||
    typeof card.description !== 'string' ||
    typeof card.example !== 'string' ||
    typeof card.systemPrompt !== 'string' ||
    !personaSettingKeys.every((key) =>
      [card.settings?.[key], card.influences?.[key]].every(
        (value) =>
          typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100,
      ),
    )
  )
    throw new TypeError('Некорректная карточка персонажа.');
  return card;
}
