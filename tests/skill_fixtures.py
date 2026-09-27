"""Empty, reloadable Skill kernel for offline runtime contract tests."""
from nerya.skills.registry import SkillRegistry


class EmptySkillKernel:
    """Keep the real registry protocol without loading or executing a Skill."""

    def __init__(self):
        self.registry = SkillRegistry()

    def reload(self):
        return self.registry
