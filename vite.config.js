export default { build: { target: 'es2022' }, server: { proxy: { '/api': 'http://localhost:8787' } } };
