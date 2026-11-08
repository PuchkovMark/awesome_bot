type Factory<T> = () => T;

/**
 * Простейший DI-контейнер для регистрации и получения сервисов по ключу.
 * Не использует внешних библиотек — достаточно для текущих целей.
 */
/**
 * Регистрирует и предоставляет зависимости приложения через контейнер инверсии управления.
 */
export class Container {
  private factories = new Map<string, Factory<unknown>>();
  private instances = new Map<string, unknown>();

  register<T>(key: string, factory: Factory<T>): void {
    this.factories.set(key, factory as Factory<unknown>);
  }

  resolve<T>(key: string): T {
    if (this.instances.has(key)) return this.instances.get(key) as T;
    const factory = this.factories.get(key);
    if (!factory) throw new Error(`Factory for ${key} not registered`);
    const inst = factory();
    this.instances.set(key, inst);
    return inst as T;
  }

  clear(): void {
    this.factories.clear();
    this.instances.clear();
  }
}

const container = new Container();
export default container;
