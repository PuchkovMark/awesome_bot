import axios from 'axios';
import config from '../../config/index.js';

export type SearchResult = {
  title: string;
  description: string;
  url: string;
};

interface SearchProvider {
  search(query: string): Promise<SearchResult[]>;
}

class BraveSearchProvider implements SearchProvider {
  async search(query: string): Promise<SearchResult[]> {
    if (!config.BRAVE_SEARCH_API_KEY) {
      throw new Error('BRAVE_SEARCH_API_KEY must be configured for web search');
    }
    const response = await axios.get<{
      web?: { results?: Array<{ title?: string; description?: string; url?: string }> };
    }>('https://api.search.brave.com/res/v1/web/search', {
      params: { q: query, count: 5 },
      headers: { 'X-Subscription-Token': config.BRAVE_SEARCH_API_KEY },
      timeout: 15_000,
      maxContentLength: 2 * 1024 * 1024,
      maxBodyLength: 2 * 1024 * 1024,
    });

    return (response.data.web?.results ?? [])
      .filter(
        (result): result is { title: string; description: string; url: string } =>
          typeof result.title === 'string' &&
          typeof result.url === 'string' &&
          typeof result.description === 'string',
      )
      .map(({ title, description, url }) => ({ title, description, url }));
  }
}

export class SearchService {
  async search(query: string): Promise<SearchResult[]> {
    if (query.trim().length < 2 || query.length > 500) {
      throw new Error('Search query must be between 2 and 500 characters');
    }
    if (config.WEB_SEARCH_PROVIDER === 'none') {
      throw new Error('Web search is disabled; configure a search provider');
    }
    const provider = new BraveSearchProvider();
    return provider.search(query);
  }
}

const searchService = new SearchService();
export default searchService;
