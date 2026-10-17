export function activate(context) {
  let writes = Promise.resolve();
  return { commands: {
    list: () => context.storage.get('cards').then(cards => cards ?? []),
    add: input => {
      if (typeof input?.title !== 'string' || !input.title.trim()) throw new Error('Enter a card title');
      const operation = writes.then(async () => {
        const cards = (await context.storage.get('cards')) ?? [];
        cards.push({ title: input.title.trim() });
        await context.storage.set('cards', cards);
        return cards;
      });
      writes = operation.catch(() => {});
      return operation;
    },
  } };
}
