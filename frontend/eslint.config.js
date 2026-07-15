import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', '*.tsbuildinfo'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // tsc (strict, noUnusedLocals) already enforces unused-vars; underscore = intentional.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // the DB layer deliberately bridges untyped driver rows; casts are contained there.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
