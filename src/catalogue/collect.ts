export async function collect<T>(...walks: AsyncGenerator<T, void, undefined>[]): Promise<T[]> {
  const items: T[] = [];
  for (const walk of walks) {
    for await (const item of walk) {
      items.push(item);
    }
  }
  return items;
}
