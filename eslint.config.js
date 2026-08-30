import js from "@eslint/js";
import globals from "globals";

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
		files: ["test/**/*.js", "scripts/**/*.js", "*.js"],
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
