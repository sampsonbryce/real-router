module.exports = {
    env: {
        browser: true,
        es2021: true,
        'jest/globals': true,
    },
    extends: ['plugin:react/recommended', 'airbnb', 'prettier'],
    parser: '@typescript-eslint/parser',
    parserOptions: {
        ecmaFeatures: {
            jsx: true,
        },
        ecmaVersion: 12,
        sourceType: 'module',
    },
    plugins: ['react', '@typescript-eslint', 'prettier', 'jest'],
    ignorePatterns: ['.eslintrc.js'],
    rules: {
        'prettier/prettier': 'error',
        'react/jsx-filename-extension': [2, { extensions: ['.js', '.jsx', '.ts', '.tsx'] }],
        'import/prefer-default-export': 'off',
        'react/react-in-jsx-scope': 'off',
        'import/extensions': [
            'error',
            'ignorePackages',
            {
                js: 'never',
                jsx: 'never',
                ts: 'never',
                tsx: 'never',
            },
        ],
        'no-unused-vars': 'off',
        '@typescript-eslint/no-unused-vars': 'error',
        'no-use-before-define': 'off',
        '@typescript-eslint/no-use-before-define': 'off',
        'no-restricted-syntax': ['error', 'LabeledStatement', 'WithStatement'],
        'no-param-reassign': ['error', { props: true, ignorePropertyModificationsFor: ['draft'] }],
        'no-restricted-globals': 'off',
    },
    settings: {
        'import/resolver': {
            node: {
                moduleDirectory: ['node_modules', 'src'],
                extensions: ['.js', '.jsx', '.ts', '.tsx'],
            },
        },
    },
    globals: {
        JSX: true,
    },
};
