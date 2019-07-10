import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import which from "which";

import * as Atom from "atom";
import { MessagePanelView } from "atom-message-panel";
import { LinterBody } from "./types";

const VALID_SEVERITY = ["error", "warning", "info"];
const char1glslRegex = /^(.*(?:\.|_))(v|g|f)(\.glsl)$/;
const char2glslRegex = /^(.*(?:\.|_))(vs|tc|te|gs|fs|cs)(\.glsl)$/;
const char1shRegex = /^(.*\.)(v|g|f)sh$/;
const char2Regex = /^(.*\.)(vs|tc|te|gs|fs|cs)$/;
const defaultRegex = /^(.*\.)(vert|frag|geom|tesc|tese|comp)$/;

const compileRegex = "^([\\w \\-]+): (\\d+):(\\d+): (.*)$";
const linkRegex = "^([\\w \\-]+): Linking {{typeName}} stage: (.*)$";

interface ShaderType {
    char1?: string;
    char2: string;
    char4: string;
    name: string;
}

interface Shader {
    type: ShaderType;
    name: string;
    fullFilename?: string;
    contents: string;
    outFilename?: string;
}

interface ShaderTokens {
    baseFilename: string;
    baseShaderType: ShaderType;
    dirName: string;
    outFilename: string;
    fullFilename: string;
}

type Range = [[number, number], [number, number]];
interface LintResult {
    severity: string;
    excerpt: string;
    location: {
        file?: string;
        position: Range;
    };
}

const shaderTypes: ShaderType[] = [
    {
        char1: "v",
        char2: "vs",
        char4: "vert",
        name: "vertex"
    },
    {
        char1: "f",
        char2: "fs",
        char4: "frag",
        name: "fragment"
    },
    {
        char1: "g",
        char2: "gs",
        char4: "geom",
        name: "geometry"
    },
    {
        char2: "te",
        char4: "tese",
        name: "tessellation evaluation"
    },
    {
        char2: "tc",
        char4: "tesc",
        name: "tessellation control"
    },
    {
        char2: "cs",
        char4: "comp",
        name: "compute"
    }
];

const getSeverity = (givenSeverity: string): string => {
    const severity = givenSeverity.toLowerCase();
    return VALID_SEVERITY.includes(severity) ? severity : "warning";
};

const shaderTypeLookup = (
    fieldName: keyof ShaderType,
    fieldValue: string
): ShaderType =>
    shaderTypes.filter(
        (shaderType): boolean => shaderType[fieldName] === fieldValue
    )[0];

const shaderByChar1 = (char1: string): ShaderType =>
    shaderTypeLookup("char1", char1);
const shaderByChar2 = (char2: string): ShaderType =>
    shaderTypeLookup("char2", char2);
const shaderByChar4 = (char4: string): ShaderType =>
    shaderTypeLookup("char4", char4);

const parseGlslValidatorResponse = (
    inputs: Shader[],
    output: string,
    firstRowRange: Range
): Promise<LintResult[]> =>
    new Promise((resolve): void => {
        const toReturn: LintResult[] = [];

        inputs.forEach((shader): void => {
            let compileStarted = false;
            const typeName = shader.type.name;

            output.split(os.EOL).forEach((line: string): void => {
                if (line.endsWith(shader.name)) {
                    compileStarted = true;
                } else if (compileStarted || inputs.length === 1) {
                    const match = new RegExp(compileRegex).exec(line);
                    if (match) {
                        const lineStart = parseInt(match[3], 10);
                        const colStart = parseInt(match[2], 10);
                        const lineEnd = lineStart;
                        const colEnd = colStart;

                        toReturn.push({
                            severity: getSeverity(match[1]),
                            excerpt: match[4].trim(),
                            location: {
                                file: shader.fullFilename,
                                position: [
                                    [
                                        lineStart > 0 ? lineStart - 1 : 0,
                                        colStart > 0 ? colStart - 1 : 0
                                    ],
                                    [
                                        lineEnd > 0 ? lineEnd - 1 : 0,
                                        colEnd > 0 ? colEnd - 1 : 0
                                    ]
                                ]
                            }
                        });
                    } else {
                        compileStarted = false;
                    }
                }

                const linkMatch = new RegExp(
                    linkRegex.replace("{{typeName}}", typeName)
                ).exec(line);
                if (linkMatch) {
                    toReturn.push({
                        severity: getSeverity(linkMatch[1]),
                        excerpt: linkMatch[2].trim(),
                        location: {
                            file: shader.fullFilename,
                            position: firstRowRange
                        }
                    });
                }
            });
        });
        resolve(toReturn);
    });

const extractShaderFilenameTokens = (shaderFilename: string): ShaderTokens => {
    const fileName = path.basename(shaderFilename);
    const dirName = path.dirname(shaderFilename);

    let baseFilename;
    let baseShaderType: ShaderType;

    const extChar1GlslMatch = char1glslRegex.exec(fileName);
    const extChar2GlslMatch = char2glslRegex.exec(fileName);
    const extChar2Match = char2Regex.exec(fileName);
    const extChar1ShMatch = char1shRegex.exec(fileName);
    const extDefaultMatch = defaultRegex.exec(fileName);

    if (extChar1GlslMatch) {
        baseFilename = extChar1GlslMatch[1];
        baseShaderType = shaderByChar1(extChar1GlslMatch[2]);
    } else if (extChar2GlslMatch) {
        baseFilename = extChar2GlslMatch[1];
        baseShaderType = shaderByChar2(extChar2GlslMatch[2]);
    } else if (extChar1ShMatch) {
        baseFilename = extChar1ShMatch[1];
        baseShaderType = shaderByChar1(extChar1ShMatch[2]);
    } else if (extChar2Match) {
        baseFilename = extChar2Match[1];
        baseShaderType = shaderByChar2(extChar2Match[2]);
    } else if (extDefaultMatch) {
        baseFilename = extDefaultMatch[1];
        baseShaderType = shaderByChar4(extDefaultMatch[2]);
    } else {
        throw Error("Unknown shader type");
    }

    let outFilename = baseFilename;
    if (!outFilename.endsWith(".")) outFilename += ".";

    outFilename += baseShaderType.char4;

    return {
        baseFilename,
        baseShaderType,
        dirName,
        outFilename,
        fullFilename: shaderFilename
    };
};

// Internal states
interface State {
    subscriptions?: Atom.CompositeDisposable;
    glslangValidatorPath?: string;
    messages?: MessagePanelView;
}
const state: State = {};

export default {
    config: {
        glslangValidatorPath: {
            type: "string",
            default: "glslangValidator",
            order: 1
        }
    },

    activate(): void {
        require("atom-package-deps").install("linter-glsl");
        const { PlainMessageView } = require("atom-message-panel"); // eslint-disable-line

        state.subscriptions = new Atom.CompositeDisposable();

        state.subscriptions.add(
            atom.config.observe(
                "linter-glsl.glslangValidatorPath",
                (glslangValidatorPath: string): void => {
                    state.glslangValidatorPath =
                        module.exports.config.glslangValidatorPath.default;
                    if (
                        fs.existsSync(glslangValidatorPath) &&
                        fs.statSync(glslangValidatorPath).isFile()
                    ) {
                        try {
                            fs.accessSync(
                                glslangValidatorPath,
                                fs.constants.X_OK
                            );
                            state.glslangValidatorPath = glslangValidatorPath;
                        } catch (error) {
                            // eslint-disable-next-line no-console
                            console.log(error);
                        }
                    } else {
                        try {
                            state.glslangValidatorPath = which.sync(
                                glslangValidatorPath
                            );
                        } catch (error) {
                            // eslint-disable-next-line no-console
                            console.log(error);
                        }
                    }

                    if (state.glslangValidatorPath) {
                        if (state.messages) {
                            state.messages.close();
                            state.messages = undefined;
                        }
                    } else {
                        if (!state.messages) {
                            state.messages = new MessagePanelView({
                                title: "linter-glslify"
                            });
                            state.messages.attach();
                            state.messages.toggle();
                        }
                        state.messages.clear();
                        state.messages.add(
                            new PlainMessageView({
                                message: `Unable to locate glslangValidator at '${glslangValidatorPath}'`,
                                className: "text-error"
                            })
                        );
                    }
                }
            )
        );
    },

    deactivate(): void {
        if (state.subscriptions) {
            state.subscriptions.dispose();
        }
    },

    provideLinter(): LinterBody {
        const helpers = require("atom-linter"); // eslint-disable-line

        return {
            name: "glsl",
            grammarScopes: ["source.glsl"],
            scope: "file",
            lintsOnChange: true,
            lint: (editor: Atom.TextEditor): Promise<null> => {
                const file = editor.getPath();
                const content = editor.getText();
                let command = state.glslangValidatorPath;

                if (state.glslangValidatorPath === undefined) {
                    command =
                        module.exports.config.glslangValidatorPath.default;
                }

                if (!file) {
                    throw "editor.getPath failed"; // TODO: fix
                }
                const shaderFileTokens = extractShaderFilenameTokens(file);

                let filesToValidate: Shader[] = [
                    {
                        name: shaderFileTokens.outFilename,
                        fullFilename: file,
                        type: shaderFileTokens.baseShaderType,
                        contents: content
                    }
                ];
                let args: string[] = [];

                return helpers
                    .tempFiles(
                        filesToValidate,
                        (files: string[]): Promise<void> =>
                            helpers.exec(command, args.concat(files), {
                                stream: "stdout",
                                ignoreExitCode: true
                            })
                    )
                    .then(
                        (output: string): Promise<LintResult[]> =>
                            parseGlslValidatorResponse(
                                filesToValidate,
                                output,
                                helpers.generateRange(editor, 0)
                            )
                    )
                    .catch((error: Error): null => {
                        // eslint-disable-next-line no-console
                        console.error(error);
                        // Since something went wrong executing, return null so
                        // Linter doesn't update any current results
                        return null;
                    });
            }
        };
    }
};
