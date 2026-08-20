export function applyTemplate(template: string, firstName: string): string {
  if (!firstName) {
    return template.replaceAll("Hi {{first_name}},", "Hi there,").replaceAll("{{first_name}}", "");
  }
  return template.replaceAll("{{first_name}}", firstName);
}
