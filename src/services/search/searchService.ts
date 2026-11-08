import axios from 'axios';
import config from '../../config/index.js';
import { logger } from '../../logger/index.js';

export type SearchResult = {
  title: string;
  description: string;
  url: string;
};

export type SearchResponse = {
  provider: 'serper' | 'tavily';
  results: SearchResult[];
};

interface SearchProvider {
  readonly name: 'serper' | 'tavily';
  search(query: string): Promise<SearchResult[]>;
}

/**
 * Выполняет веб-поиск через Serper и приводит результаты к общему формату поиска.
 */
class SerperSearchProvider implements SearchProvider {
  public readonly name = 'serper';

  async search(query: string): Promise<SearchResult[]> {
    if (!config.SERPER_API_KEY) {
      throw new Error('SERPER_API_KEY must be configured for web search');
    }
    const response = await axios.post<{
      organic?: Array<{ title?: string; snippet?: string; link?: string }>;
    }>(
      'https://google.serper.dev/search',
      { q: query, num: 5 },
      {
        headers: { 'X-API-KEY': config.SERPER_API_KEY },
        timeout: 15_000,
        maxContentLength: 2 * 1024 * 1024,
        maxBodyLength: 2 * 1024 * 1024,
      },
    );

    return (response.data.organic ?? [])
      .filter(
        (result): result is { title: string; snippet?: string; link: string } =>
          typeof result.title === 'string' && typeof result.link === 'string',
      )
      .map(({ title, snippet, link }) => ({
        title,
        description: snippet ?? '',
        url: link,
      }));
  }
}

/**
 * Выполняет веб-поиск через Tavily и приводит результаты к общему формату поиска.
 */
class TavilySearchProvider implements SearchProvider {
  public readonly name = 'tavily';

  async search(query: string): Promise<SearchResult[]> {
    if (!config.TAVILY_API_KEY) {
      throw new Error('TAVILY_API_KEY must be configured for web search');
    }
    const response = await axios.post<{
      results?: Array<{ title?: string; content?: string; url?: string }>;
    }>(
      'https://api.tavily.com/search',
      {
        api_key: config.TAVILY_API_KEY,
        query,
        max_results: 5,
      },
      {
        timeout: 15_000,
        maxContentLength: 2 * 1024 * 1024,
        maxBodyLength: 2 * 1024 * 1024,
      },
    );

    return (response.data.results ?? [])
      .filter(
        (result): result is { title: string; content?: string; url: string } =>
          typeof result.title === 'string' && typeof result.url === 'string',
      )
      .map(({ title, content, url }) => ({
        title,
        description: content ?? '',
        url,
      }));
  }
}

/**
 * Выбирает настроенный поисковый провайдер и применяет резервный поиск при необходимости.
 */
export class SearchService {
  async search(query: string): Promise<SearchResponse> {
    if (query.trim().length < 2 || query.length > 500) {
      throw new Error('Search query must be between 2 and 500 characters');
    }
    if (config.WEB_SEARCH_PROVIDER === 'none') {
      throw new Error('Web search is disabled; configure a search provider');
    }
    const providers: SearchProvider[] =
      config.WEB_SEARCH_PROVIDER === 'serper'
        ? [new SerperSearchProvider(), new TavilySearchProvider()]
        : [new TavilySearchProvider(), new SerperSearchProvider()];
    const errors: Error[] = [];

    for (const [index, provider] of providers.entries()) {
      try {
        const results = await provider.search(query);
        if (results.length > 0 || index === providers.length - 1) {
          return { provider: provider.name, results };
        }
        logger.warn(
          { provider: provider.name },
          'Search provider returned no results; trying fallback',
        );
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        errors.push(error);
        logger.warn({ err, provider: provider.name }, 'Search provider failed');
      }
    }

    throw new AggregateError(errors, 'All configured web search providers failed');
  }
}

const searchService = new SearchService();
export default searchService;
