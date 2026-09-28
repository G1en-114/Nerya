"""A small causal expression language, interpreted without eval/exec.

Inputs are closed OHLCV bars. Windows are trailing, delay is nonnegative,
and undefined values remain missing (never backfilled from the future).
"""
from __future__ import annotations

import ast
import math
import operator
from typing import Any

import numpy as np
import pandas as pd

FIELDS = frozenset({"open", "high", "low", "close", "volume"})
WINDOWS = frozenset({"sma", "ema", "std", "zscore", "ts_min", "ts_max", "delay", "delta"})
FUNCTIONS = WINDOWS | {"abs", "log"}
BINARY = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv}


class FactorExpression:
    def __init__(self, expression: str, parameters: dict[str, Any] | None = None):
        if not isinstance(expression, str) or not 1 <= len(expression) <= 2000:
            raise ValueError("expression must contain 1–2000 characters")
        self.parameters = dict(parameters or {})
        if len(self.parameters) > 32:
            raise ValueError("at most 32 parameters are supported")
        for key, value in self.parameters.items():
            if not key.isidentifier() or key.startswith("_") or key in FIELDS | FUNCTIONS:
                raise ValueError(f"invalid parameter name: {key}")
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or abs(value) > 1e9:
                raise ValueError(f"parameter {key} must be a bounded finite number")
        try:
            self.tree = ast.parse(expression.strip(), mode="eval")
        except (SyntaxError, RecursionError) as exc:
            raise ValueError("invalid factor expression") from exc
        if sum(1 for _ in ast.walk(self.tree)) > 180:
            raise ValueError("expression is too complex; extract smaller reusable components")
        self.inputs: set[str] = set()
        self.lookback = self._check(self.tree.body)
        if not self.inputs:
            raise ValueError("a factor must depend on at least one OHLCV input")
        if self.lookback > 20000:
            raise ValueError("combined lookback exceeds 20000 bars")
        self.canonical = ast.dump(self.tree, annotate_fields=True, include_attributes=False)

    def _window(self, node: ast.AST, function: str) -> int:
        value = node.value if isinstance(node, ast.Constant) else self.parameters.get(node.id) if isinstance(node, ast.Name) else None
        minimum = 0 if function == "delay" else 1
        if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value or not minimum <= value <= 10000:
            raise ValueError(f"{function} needs a constant integer window in [{minimum}, 10000]; future shifts are forbidden")
        return int(value)

    def _check(self, node: ast.AST) -> int:
        if isinstance(node, ast.Name):
            if node.id in FIELDS:
                self.inputs.add(node.id)
                return 1
            if node.id in self.parameters:
                return 0
        elif isinstance(node, ast.Constant):
            if not isinstance(node.value, bool) and isinstance(node.value, (int, float)) and math.isfinite(node.value) and abs(node.value) <= 1e9:
                return 0
        elif isinstance(node, ast.BinOp) and type(node.op) in BINARY:
            return max(self._check(node.left), self._check(node.right))
        elif isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            return self._check(node.operand)
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and not node.keywords:
            name = node.func.id
            if name in FUNCTIONS and len(node.args) == (2 if name in WINDOWS else 1):
                history = self._check(node.args[0])
                if name in WINDOWS:
                    n = self._window(node.args[1], name)
                    return history + n if name in {"delay", "delta"} else history + n - 1
                return history
        raise ValueError("unsupported expression: use OHLCV, parameters, + - * / and trailing factor functions only")

    def calculate(self, frame: pd.DataFrame) -> pd.Series:
        if not self.inputs.issubset(frame.columns):
            raise ValueError(f"missing inputs: {sorted(self.inputs - set(frame.columns))}")

        def series(value: Any) -> pd.Series:
            return value if isinstance(value, pd.Series) else pd.Series(value, index=frame.index, dtype=float)

        def visit(node: ast.AST):
            if isinstance(node, ast.Name):
                return frame[node.id].astype(float) if node.id in FIELDS else self.parameters[node.id]
            if isinstance(node, ast.Constant):
                return node.value
            if isinstance(node, ast.UnaryOp):
                return -visit(node.operand) if isinstance(node.op, ast.USub) else visit(node.operand)
            if isinstance(node, ast.BinOp):
                left, right = series(visit(node.left)), series(visit(node.right))
                if isinstance(node.op, ast.Div):
                    right = right.replace(0, np.nan)
                return BINARY[type(node.op)](left, right)
            name = node.func.id
            value = series(visit(node.args[0]))
            if name == "abs":
                return value.abs()
            if name == "log":
                return np.log(value.where(value > 0))
            n = self._window(node.args[1], name)
            if name == "delay":
                return value.shift(n)
            if name == "delta":
                return value - value.shift(n)
            if name == "ema":
                # pandas carries the previous EMA over a missing observation.
                # Keep recursive weighting, but do not manufacture a usable
                # factor value on a bar whose expression input is undefined.
                return value.ewm(span=n, adjust=False, min_periods=n, ignore_na=False).mean().where(value.notna())
            rolling = value.rolling(n, min_periods=n)
            if name == "sma":
                return rolling.mean()
            if name == "std":
                return rolling.std(ddof=0)
            if name == "zscore":
                return (value - rolling.mean()) / rolling.std(ddof=0).replace(0, np.nan)
            return rolling.min() if name == "ts_min" else rolling.max()

        with np.errstate(all="ignore"):
            return series(visit(self.tree.body)).replace([np.inf, -np.inf], np.nan)
