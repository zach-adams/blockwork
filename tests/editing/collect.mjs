import { pathToFileURL } from 'node:url';

await import(pathToFileURL(process.argv[2]).href);
