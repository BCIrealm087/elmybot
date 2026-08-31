import js from "@eslint/js";
import globals from "globals";
import featureApiBoundary from "./scripts/eslint/feature-api-boundary.js";

export default [
	{
		ignores: [
			".wrangler/**",
			".wrangler-dry-run/**",
			"coverage/**",
			"node_modules/**"
		]
	},
	js.configs.recommended,
	{
		files: ["src/**/*.js"],
		languageOptions: {
			ecmaVersion: "latest",
			sourceType: "module",
			globals: {
				...globals.nodeBuiltin,
				...globals.serviceworker
			}
		},
		rules: {
			"no-unused-vars": ["error", {
				argsIgnorePattern: "^_",
				caughtErrors: "none"
			}]
		}
	},
	{
		files: [
			"src/features/*/*.js",
			"src/features/*/**/*.js",
			"packages/features/*/src/**/*.js"
		],
		plugins: {
			"feature-api": featureApiBoundary
		},
		rules: {
			"feature-api/public-api-only": "error"
		}
	},
	{
		files: [
			"test/**/*.js",
			"packages/features/*/test/**/*.js",
			"scripts/**/*.js",
			"*.js"
		],
		languageOptions: {
			ecmaVersion: "latest",
			sourceType: "module",
			globals: {
				...globals.browser,
				...globals.node,
				...globals.vitest
			}
		},
		rules: {
			"no-unused-vars": ["error", {
				argsIgnorePattern: "^_",
				caughtErrors: "none"
			}]
		}
	}
];
