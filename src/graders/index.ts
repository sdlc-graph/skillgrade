import { GraderConfig, GraderResult, EnvironmentProvider } from '../types';
import * as fs from 'fs-extra';
import * as path from 'path';
import { ToolUsageGrader } from './tool_usage';
import { GoogleGenerativeAI, SchemaType, Schema } from "@google/generative-ai";

export interface Grader {
    grade(
        workspace: string,
        provider: EnvironmentProvider,
        config: GraderConfig,
        taskPath: string,
        sessionLog: any[],
        env?: Record<string, string>
    ): Promise<GraderResult>;
}

/**
 * Runs a command and parses structured JSON from stdout.
 *
 * The grader script MUST output JSON to stdout:
 *   { "score": 0.0-1.0, "details": "...", "checks": [...] }
 *
 * - score: float between 0.0 and 1.0
 * - details: human-readable summary
 * - checks: optional array of { name, passed, message } for per-check breakdown
 */
export class DeterministicGrader implements Grader {
    async grade(
        workspace: string,
        provider: EnvironmentProvider,
        config: GraderConfig,
        _taskPath: string,
        _sessionLog: any[],
        env?: Record<string, string>
    ): Promise<GraderResult> {
        const command = config.command || 'bash tests/test.sh';
        const result = await provider.runCommand(workspace, command, env);

        // Parse JSON from stdout
        const jsonMatch = result.stdout.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return {
                grader_type: 'deterministic',
                score: 0,
                weight: config.weight,
                details: `Grader did not output JSON. stdout: ${result.stdout.trim() || '(empty)'} stderr: ${result.stderr.trim() || '(empty)'}`
            };
        }

        try {
            const parsed = JSON.parse(jsonMatch[0]);
            const score = Math.max(0, Math.min(1, parseFloat(parsed.score) || 0));
            const details = parsed.details || `score=${score.toFixed(2)}`;
            const checks = parsed.checks || [];

            // Build rich details string with per-check breakdown
            const checkLines = checks.map((c: any) =>
                `  ${c.passed ? '✓' : '✗'} ${c.name}: ${c.message || ''}`
            );
            const fullDetails = checkLines.length > 0
                ? `${details}\n${checkLines.join('\n')}`
                : details;

            return {
                grader_type: 'deterministic',
                score,
                weight: config.weight,
                details: fullDetails
            };
        } catch (e) {
            return {
                grader_type: 'deterministic',
                score: 0,
                weight: config.weight,
                details: `Failed to parse grader JSON: ${jsonMatch[0].substring(0, 200)}`
            };
        }
    }
}

/**
 * Uses an LLM to evaluate the agent's session transcript against a rubric.
 * Requires GEMINI_API_KEY or ANTHROPIC_API_KEY in the environment.
 */
export class LLMGrader implements Grader {
    async grade(
        _workspace: string,
        _provider: EnvironmentProvider,
        config: GraderConfig,
        taskPath: string,
        sessionLog: any[],
        env?: Record<string, string>
    ): Promise<GraderResult> {
        let assertions: string[] = config.outcome_assertions || [];
        let rubricContent = '';

        if (assertions.length === 0) {
            const rubricPath = path.join(taskPath, config.rubric || 'prompts/quality.md');
            if (!await fs.pathExists(rubricPath)) {
                return {
                    grader_type: 'llm_rubric',
                    score: 0,
                    weight: config.weight,
                    details: `Rubric file not found: ${rubricPath}`
                };
            }
            rubricContent = await fs.readFile(rubricPath, 'utf-8');
        }

        // Build a comprehensive transcript for the LLM
        const sections: string[] = [];

        // Include the original instruction
        const instructionEntry = sessionLog.find(e => e.type === 'agent_start');
        if (instructionEntry?.instruction) {
            sections.push(`## Task Instruction\n${instructionEntry.instruction}`);
        }

        // Include agent output
        const agentEntry = sessionLog.find(e => e.type === 'agent_result');
        if (agentEntry?.output) {
            sections.push(`## Agent Output\n${agentEntry.output}`);
        }

        // Include results from any prior graders (e.g., deterministic tests)
        const priorGraders = sessionLog
            .filter(e => e.type === 'grader' && e.grader_result)
            .map(e => e.grader_result!);
        if (priorGraders.length > 0) {
            const results = priorGraders.map(g =>
                `- ${g.grader_type}: score=${g.score.toFixed(2)} — ${g.details}`
            ).join('\n');
            sections.push(`## Prior Grader Results (automated tests)\n${results}`);
        }

        const transcript = sections.join('\n\n');

        const prompt = `You are an evaluation judge. Score the following agent session ${assertions.length > 0 
            ? 'based on the rubric below.\nFor each assertion in the rubric, provide a score between 0.0 and 1.0 and a brief explanation.' 
            : 'on a scale from 0.0 to 1.0 based on the rubric below.'}

IMPORTANT CONTEXT: The agent runs inside a CLI wrapper (e.g., Gemini CLI). The agent's tool calls (file edits, shell commands) appear as text in the "Agent Output" section. This is a real execution trace, not hallucination. The "Prior Grader Results" section shows objective automated test results that verify the actual filesystem state after the agent ran.

## Rubric
${assertions.length > 0 ? assertions.map((a, i) => `${i+1}. ${a}`).join('\n') : rubricContent}

## Session Transcript
${transcript}

${assertions.length > 0 
    ? `Respond with ONLY a JSON object where the keys are the EXACT assertions listed above:
{
  "Assertion 1 text": {"score": <number>, "reasoning": "<explanation>"},
  "Assertion 2 text": ...
}` 
    : 'Respond with ONLY a JSON object: {"score": <number>, "reasoning": "<brief explanation>"}'}`;

        // Try Gemini API first, fall back to Anthropic
        const apiKey = env?.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
        const anthropicKey = env?.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;

        if (apiKey) {
            return this.callGemini(prompt, apiKey, config, assertions);
        } else if (anthropicKey) {
            return this.callAnthropic(prompt, anthropicKey, config);
        }

        return {
            grader_type: 'llm_rubric',
            score: 0,
            weight: config.weight,
            details: 'No API key available for LLM grading (set GEMINI_API_KEY or ANTHROPIC_API_KEY)'
        };
    }

    private async callGemini(prompt: string, apiKey: string, config: GraderConfig, assertions?: string[]): Promise<GraderResult> {
        const genAI = new GoogleGenerativeAI(apiKey);
            
        // Define the exact shape of the JSON
        let schema: Schema = {
            type: SchemaType.OBJECT,
            properties: {
                score: { type: SchemaType.NUMBER },
                reasoning: { type: SchemaType.STRING },
            },
            required: ["score", "reasoning"],
        };

        if (assertions && assertions.length > 0) {
            const properties: Record<string, Schema> = {};
            const required: string[] = [];
            
            for (const a of assertions) {
                properties[a] = {
                    type: SchemaType.OBJECT,
                    properties: {
                        score: { type: SchemaType.NUMBER },
                        reasoning: { type: SchemaType.STRING },
                    },
                    required: ["score", "reasoning"],
                };
                required.push(a);
            }

            schema = {
                type: SchemaType.OBJECT,
                properties: properties,
                required: required,
            };
        }

        const model = genAI.getGenerativeModel({
            model: config.model || 'gemini-3-flash-preview',
            generationConfig: {
                temperature: 0,
                responseMimeType: "application/json",
                responseSchema: schema,
            },
        });

        try {
            const result = await model.generateContent(prompt);
            const text = result.response.text();
            
            if (!text) {
                return {
                    grader_type: 'llm_rubric',
                    score: 0,
                    weight: config.weight,
                    details: 'Failed to parse LLM response: empty response'
                };
            }

            // Strip markdown code fences if present (defensive)
            let cleaned = text.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim();
            
            try {
                const parsed = JSON.parse(cleaned);
                if (assertions && assertions.length > 0) {
                    const scores: number[] = [];
                    const detailsLines: string[] = [];
                    for (const a of assertions) {
                        const evalItem = parsed[a];
                        if (evalItem) {
                            scores.push(evalItem.score);
                            detailsLines.push(`  ${evalItem.score >= 0.5 ? '✓' : '✗'} ${a}: ${evalItem.reasoning}`);
                        }
                    }
                    const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
                    return {
                        grader_type: 'llm_rubric',
                        score: avgScore,
                        weight: config.weight,
                        details: detailsLines.join('\n')
                    };
                }

                return {
                    grader_type: 'llm_rubric',
                    score: parsed.score,
                    weight: config.weight,
                    details: parsed.reasoning
                };
            } catch (e) {
                return {
                    grader_type: 'llm_rubric',
                    score: 0,
                    weight: config.weight,
                    details: `Failed to parse LLM response: ${text.substring(0, 200)}`
                };
            }
        } catch (e) {
            return { 
                grader_type: 'llm_rubric', 
                score: 0, 
                weight: config.weight, 
                details: `Gemini API error: ${e}` 
            };
        }
    }

    private async callAnthropic(prompt: string, apiKey: string, config: GraderConfig): Promise<GraderResult> {
        const model = config.model || 'claude-sonnet-4-20250514';
        try {
            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model,
                    max_tokens: 4096,
                    messages: [{ role: 'user', content: prompt }]
                })
            });

            const data = await response.json() as any;
            const text = data?.content?.[0]?.text || '';
            return this.parseResponse(text, config);
        } catch (e) {
            return { grader_type: 'llm_rubric', score: 0, weight: config.weight, details: `Anthropic API error: ${e}` };
        }
    }

    /**
     * @deprecated This function is a duplicate of the logic in callGemini.
     * We will eventually migrate off this approach entirely.
     */
    private parseResponse(text: string, config: GraderConfig): GraderResult {
        try {
            // Strip markdown code fences if present
            let cleaned = text.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim();

            // Extract JSON from response
            const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                
                const assertions = config.outcome_assertions || [];
                if (assertions.length > 0) {
                    const scores: number[] = [];
                    const detailsLines: string[] = [];
                    for (const a of assertions) {
                        const evalItem = parsed[a];
                        if (evalItem) {
                            scores.push(evalItem.score);
                            detailsLines.push(`  ${evalItem.score >= 0.5 ? '✓' : '✗'} ${a}: ${evalItem.reasoning}`);
                        }
                    }
                    if (scores.length > 0) {
                        const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
                        return {
                            grader_type: 'llm_rubric',
                            score: avgScore,
                            weight: config.weight,
                            details: detailsLines.join('\n')
                        };
                    }
                }

                if (parsed.evaluations) {
                    const scores = parsed.evaluations.map((e: any) => e.score);
                    const avgScore = scores.reduce((a: number, b: number) => a + b, 0) / scores.length;
                    const details = parsed.evaluations.map((e: any) => `  ${e.score >= 0.5 ? '✓' : '✗'} ${e.assertion}: ${e.reasoning}`).join('\n');
                    return {
                        grader_type: 'llm_rubric',
                        score: avgScore,
                        weight: config.weight,
                        details: details
                    };
                }
                const score = Math.max(0, Math.min(1, parseFloat(parsed.score) || 0));
                return {
                    grader_type: 'llm_rubric',
                    score,
                    weight: config.weight,
                    details: parsed.reasoning || 'No reasoning provided'
                };
            }
        } catch (e) {
            // JSON parse failed — try to extract score from truncated response
            const scoreMatch = text.match(/"score"\s*:\s*([\d.]+)/);
            if (scoreMatch) {
                const score = Math.max(0, Math.min(1, parseFloat(scoreMatch[1]) || 0));
                return {
                    grader_type: 'llm_rubric',
                    score,
                    weight: config.weight,
                    details: 'Parsed score from truncated LLM response'
                };
            }
        }
        return { grader_type: 'llm_rubric', score: 0, weight: config.weight, details: `Failed to parse LLM response: ${text.substring(0, 200)}` };
    }
}

/** Resolve a grader implementation by type */
export function getGrader(type: string): Grader {
    switch (type) {
        case 'deterministic': return new DeterministicGrader();
        case 'llm_rubric': return new LLMGrader();
        case 'tool_usage': return new ToolUsageGrader();
        default: throw new Error(`Unknown grader type: ${type}`);
    }
}
