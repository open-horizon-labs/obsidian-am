import type {
	Category as MarvinCategory,
	Project as MarvinProject,
	Task as MarvinTask,
} from "@open-horizon/marvin-client";

export type Category = (
	| (Omit<MarvinCategory, "type"> & { type?: "category" | "faux" })
	| MarvinProject
) & { deepLink: string };

export type Task = MarvinTask & {
	deepLink: string;
};
