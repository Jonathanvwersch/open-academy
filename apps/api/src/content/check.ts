import { ContentValidationError, loadContent } from './load.js';

try {
  const content = await loadContent();
  console.log(
    `Content valid: ${content.concepts.length} concepts, ${content.exercises.length} exercises, ${content.projects.length} projects`,
  );
} catch (error) {
  if (error instanceof ContentValidationError) {
    for (const issue of error.issues) {
      console.error(`${issue.file} [${issue.id}] ${issue.message}`);
    }
    process.exitCode = 1;
  } else {
    console.error(error);
    process.exitCode = 1;
  }
}
