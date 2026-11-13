if (process.env.VERCEL_ENV !== 'production') {
  console.log('skipping migrations');
} else {
  const [{ env }, { createDb }, { prepareDatabase }] = await Promise.all([
    import('../src/config.js'),
    import('../src/db/client.js'),
    import('../src/db/prepare.js'),
  ]);
  const db = createDb(process.env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL);
  try {
    await prepareDatabase(db);
  } finally {
    await db.$client.end();
  }
}

export {};
