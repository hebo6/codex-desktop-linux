import type {
  AppsListParams,
  AppsListResponse,
  ConfigReadParams,
  ConfigReadResponse,
  ConfigRequirementsReadResponse,
  FuzzyFileSearchParams,
  FuzzyFileSearchResponse,
  ModelListParams,
  ModelListResponse,
  PermissionProfileListParams,
  PermissionProfileListResponse,
  PluginListParams,
  PluginListResponse,
  SkillsListParams,
  SkillsListResponse,
} from "../protocol/generated";
import type { RequestHandle, ResultValidator } from "../protocol/rpc";
import {
  validateAppsListResponse,
  validateConfigReadResponse,
  validateConfigRequirementsReadResponse,
  validateFuzzyFileSearchResponse,
  validateModelListResponse,
  validatePermissionProfileListResponse,
  validatePluginListResponse,
  validateSkillsListResponse,
} from "../protocol/validation";
import type { AppServerSession } from "./session";

type CapabilitySession = Pick<AppServerSession, "sendRequest">;

export interface CapabilityClient {
  listApps(params?: AppsListParams): RequestHandle<AppsListResponse>;
  readConfig(params?: ConfigReadParams): RequestHandle<ConfigReadResponse>;
  readConfigRequirements(): RequestHandle<ConfigRequirementsReadResponse>;
  listModels(params?: ModelListParams): RequestHandle<ModelListResponse>;
  listSkills(params?: SkillsListParams): RequestHandle<SkillsListResponse>;
  searchFiles(params: FuzzyFileSearchParams): RequestHandle<FuzzyFileSearchResponse>;
  listPermissionProfiles(
    params?: PermissionProfileListParams,
  ): RequestHandle<PermissionProfileListResponse>;
  listPlugins(params?: PluginListParams): RequestHandle<PluginListResponse>;
}

export class AppServerCapabilityClient implements CapabilityClient {
  constructor(private readonly session: CapabilitySession) {}

  listApps(params: AppsListParams = {}): RequestHandle<AppsListResponse> {
    return this.session.sendRequest({
      method: "app/list",
      params,
      validateResult: appsListResponseValidator,
    });
  }

  readConfig(params: ConfigReadParams = {}): RequestHandle<ConfigReadResponse> {
    return this.session.sendRequest({
      method: "config/read",
      params,
      validateResult: configReadResponseValidator,
    });
  }

  readConfigRequirements(): RequestHandle<ConfigRequirementsReadResponse> {
    return this.session.sendRequest({
      method: "configRequirements/read",
      validateResult: configRequirementsReadResponseValidator,
    });
  }

  listModels(params: ModelListParams = {}): RequestHandle<ModelListResponse> {
    return this.session.sendRequest({
      method: "model/list",
      params,
      validateResult: modelListResponseValidator,
    });
  }

  listSkills(params: SkillsListParams = {}): RequestHandle<SkillsListResponse> {
    return this.session.sendRequest({
      method: "skills/list",
      params,
      validateResult: skillsListResponseValidator,
    });
  }

  searchFiles(params: FuzzyFileSearchParams): RequestHandle<FuzzyFileSearchResponse> {
    return this.session.sendRequest({
      method: "fuzzyFileSearch",
      params,
      validateResult: fuzzyFileSearchResponseValidator,
    });
  }

  listPermissionProfiles(
    params: PermissionProfileListParams = {},
  ): RequestHandle<PermissionProfileListResponse> {
    return this.session.sendRequest({
      method: "permissionProfile/list",
      params,
      validateResult: permissionProfileListResponseValidator,
    });
  }

  listPlugins(params: PluginListParams = {}): RequestHandle<PluginListResponse> {
    return this.session.sendRequest({
      method: "plugin/list",
      params,
      validateResult: pluginListResponseValidator,
    });
  }
}

const appsListResponseValidator: ResultValidator<AppsListResponse> =
  validateAppsListResponse;
const configReadResponseValidator: ResultValidator<ConfigReadResponse> =
  validateConfigReadResponse;
const configRequirementsReadResponseValidator: ResultValidator<ConfigRequirementsReadResponse> =
  validateConfigRequirementsReadResponse;

const modelListResponseValidator: ResultValidator<ModelListResponse> =
  validateModelListResponse;
const skillsListResponseValidator: ResultValidator<SkillsListResponse> =
  validateSkillsListResponse;
const fuzzyFileSearchResponseValidator: ResultValidator<FuzzyFileSearchResponse> =
  validateFuzzyFileSearchResponse;
const permissionProfileListResponseValidator: ResultValidator<PermissionProfileListResponse> =
  validatePermissionProfileListResponse;
const pluginListResponseValidator: ResultValidator<PluginListResponse> =
  validatePluginListResponse;
