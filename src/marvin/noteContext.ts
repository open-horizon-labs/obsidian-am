export function marvinParentIdFromFrontmatter(
	frontmatter: Record<string, unknown> | undefined,
): string | undefined {
	const itemId = frontmatter?._id;
	const deepLink = frontmatter?.deepLink;
	const type = frontmatter?.type;
	if (
		type !== "category" && type !== "project"
		|| typeof itemId !== "string"
		|| typeof deepLink !== "string"
		|| deepLink !== `https://app.amazingmarvin.com/#p=${itemId}`
	) {
		return undefined;
	}
	return itemId;
}
