import { ContentValidationError, loadContentReport } from './load.js';

try {
  const { content, warnings } = await loadContentReport();
  console.log(
    `Content valid: ${content.concepts.length} concepts, ${content.exercises.length} exercises, ${content.projects.length} projects`,
  );
  for (const warning of warnings) {
    console.log(`warning: ${warning.file} [${warning.id}] ${warning.message}`);
  }
  console.log(`${warnings.length} warning${warnings.length === 1 ? '' : 's'}`);
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
