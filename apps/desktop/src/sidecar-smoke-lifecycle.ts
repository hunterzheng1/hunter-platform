export async function withOwnedConcurrentStarts<T, R>(
  starters: readonly (() => Promise<T>)[],
  use: (resources: readonly T[]) => Promise<R>,
  cleanup: (resource: T) => Promise<void>,
): Promise<R> {
  const settled = await Promise.allSettled(
    starters.map(async (start) => await start()),
  );
  const resources = settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : []
  );
  try {
    const failed = settled.find(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );
    if (failed !== undefined) throw failed.reason;
    return await use(resources);
  } finally {
    await Promise.all(resources.map(async (resource) => await cleanup(resource)));
  }
}
